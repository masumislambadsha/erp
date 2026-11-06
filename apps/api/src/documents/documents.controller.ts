import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UnprocessableEntityException,
} from '@nestjs/common';
import { z } from 'zod';
import { and, desc, eq, schema, type Tx, uuidv7, lt } from '@erp/db';
import { type DocTypeDef, documentInputSchema, valuesSchema } from '@erp/meta';
import { Ctx } from '../auth/auth.guard.js';
import { DocRequires } from '../authz/permissions.js';
import type { AuthContext } from '../context/request-context.js';
import { DatabaseService } from '../database/database.service.js';
import { Idempotent } from '../idempotency/idempotency.js';
import { loadDocType } from '../meta/doc-types.js';
import { isPgError } from '../pg-errors.js';
import { ZodPipe } from '../zod.pipe.js';

const { document, documentLine, numberSeries, party } = schema;
type DocRow = typeof document.$inferSelect;

const ListQuery = z.object({
  status: z.enum(['draft', 'submitted', 'cancelled']).optional(),
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Documents of any type defined in metadata. The database owns the lifecycle (draft at insert, the
 * number at submit, no edits afterwards, cancel only while unlocked and unissued), so this code
 * asks for each transition and reports the database's refusal; it does not re-implement the rules.
 */
@Controller('documents/:docType')
export class DocumentsController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @DocRequires('read')
  @Get()
  list(
    @Ctx() auth: AuthContext,
    @Param('docType') docType: string,
    @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>,
  ) {
    return this.database.withTenant(auth, async (tx) => {
      await loadDocType(tx, docType);
      const where = and(
        eq(document.docType, docType),
        q.status ? eq(document.status, q.status) : undefined,
        q.before ? lt(document.id, q.before) : undefined,
      );
      const rows = await tx.db
        .select({ d: document, partyName: party.name })
        .from(document)
        .leftJoin(party, and(eq(party.tenantId, document.tenantId), eq(party.id, document.partyId)))
        .where(where)
        .orderBy(desc(document.id))
        .limit(q.limit);
      return {
        rows: rows.map((r) => ({ ...summary(r.d), partyName: r.partyName })),
        next: rows.length === q.limit ? rows[rows.length - 1]!.d.id : null,
      };
    });
  }

  @DocRequires('read')
  @Get(':id')
  get(
    @Ctx() auth: AuthContext,
    @Param('docType') docType: string,
    @Param('id', new ZodPipe(z.uuid())) id: string,
  ) {
    return this.database.withTenant(auth, (tx) => view(tx, auth, docType, id));
  }

  @DocRequires('create')
  @Idempotent()
  @Post()
  async create(@Ctx() auth: AuthContext, @Param('docType') docType: string, @Body() body: unknown) {
    return this.run(() =>
      this.database.withTenant(auth, async (tx) => {
        const t = await loadDocType(tx, docType);
        if (!t.isActive) throw new ConflictException('this document type is inactive');
        const input = parse(documentInputSchema(t.def), body);
        await checkParties(tx, t.def, input.values, input.partyId);
        const id = await insertDraft(tx, auth, docType, t.def, input, null);
        return view(tx, auth, docType, id);
      }),
    );
  }

  @DocRequires('update')
  @Idempotent()
  @Patch(':id')
  async update(
    @Ctx() auth: AuthContext,
    @Param('docType') docType: string,
    @Param('id', new ZodPipe(z.uuid())) id: string,
    @Body() body: unknown,
  ) {
    return this.run(() =>
      this.database.withTenant(auth, async (tx) => {
        const t = await loadDocType(tx, docType);
        const { version, ...rest } = parse(
          z.object({ version: z.number().int().min(1) }).passthrough(),
          body,
        ) as { version: number } & Record<string, unknown>;
        const input = parse(documentInputSchema(t.def), rest);
        await checkParties(tx, t.def, input.values, input.partyId);
        const changed = await tx.db
          .update(document)
          .set({
            postingDate: input.postingDate,
            currency: input.currency,
            partyId: input.partyId ?? null,
            ext: input.values,
            version: version + 1,
          })
          .where(
            and(
              eq(document.id, id),
              eq(document.docType, docType),
              eq(document.status, 'draft'),
              eq(document.version, version),
            ),
          )
          .returning({ id: document.id });
        if (changed.length === 0) {
          const [cur] = await tx.db
            .select()
            .from(document)
            .where(and(eq(document.id, id), eq(document.docType, docType)));
          if (!cur) throw new NotFoundException();
          throw new ConflictException(
            cur.status === 'draft'
              ? `the draft changed since version ${version}: reload it`
              : `a ${cur.status} document cannot be edited`,
          );
        }
        if (input.lines) {
          await tx.db.delete(documentLine).where(eq(documentLine.documentId, id));
          await insertLines(tx, auth, id, input.companyId, input.lines);
        }
        return view(tx, auth, docType, id);
      }),
    );
  }

  @DocRequires('update')
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Ctx() auth: AuthContext,
    @Param('docType') docType: string,
    @Param('id', new ZodPipe(z.uuid())) id: string,
  ) {
    await this.run(() =>
      this.database.withTenant(auth, async (tx) => {
        const [cur] = await tx.db
          .select()
          .from(document)
          .where(and(eq(document.id, id), eq(document.docType, docType)));
        if (!cur) throw new NotFoundException();
        if (cur.status !== 'draft')
          throw new ConflictException(`a ${cur.status} document is cancelled, never deleted`);
        await tx.db.delete(documentLine).where(eq(documentLine.documentId, id));
        await tx.db.delete(document).where(eq(document.id, id));
      }),
    );
  }

  /** Submit: validate the draft against the current definition, then let the database number and freeze it. */
  @DocRequires('submit')
  @Idempotent()
  @Post(':id/submit')
  @HttpCode(200)
  async submit(
    @Ctx() auth: AuthContext,
    @Param('docType') docType: string,
    @Param('id', new ZodPipe(z.uuid())) id: string,
  ) {
    return this.run(() =>
      this.database.withTenant(auth, async (tx) => {
        const t = await loadDocType(tx, docType);
        const [cur] = await tx.db
          .select()
          .from(document)
          .where(and(eq(document.id, id), eq(document.docType, docType)));
        if (!cur) throw new NotFoundException();
        if (cur.status !== 'draft')
          throw new ConflictException(`document is already ${cur.status}`);
        const problems = validateForSubmit(t.def, cur, await countLines(tx, id));
        if (problems.length)
          throw new UnprocessableEntityException({
            message: 'the draft is not ready to submit',
            issues: problems,
          });
        const done = await tx.db
          .update(document)
          .set({ status: 'submitted' })
          .where(and(eq(document.id, id), eq(document.status, 'draft')))
          .returning({ id: document.id });
        if (done.length === 0) throw new ConflictException('document is no longer a draft');
        return view(tx, auth, docType, id);
      }),
    );
  }

  @DocRequires('cancel')
  @Idempotent()
  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(
    @Ctx() auth: AuthContext,
    @Param('docType') docType: string,
    @Param('id', new ZodPipe(z.uuid())) id: string,
  ) {
    return this.run(() =>
      this.database.withTenant(auth, async (tx) => {
        const [cur] = await tx.db
          .select()
          .from(document)
          .where(and(eq(document.id, id), eq(document.docType, docType)));
        if (!cur) throw new NotFoundException();
        if (cur.status !== 'submitted')
          throw new ConflictException(
            cur.status === 'draft'
              ? 'a draft is deleted, not cancelled'
              : 'document is already cancelled',
          );
        await tx.db.update(document).set({ status: 'cancelled' }).where(eq(document.id, id));
        return view(tx, auth, docType, id);
      }),
    );
  }

  /** Amend: a new draft that copies a cancelled document and points back to it. */
  @DocRequires('amend')
  @Idempotent()
  @Post(':id/amend')
  async amend(
    @Ctx() auth: AuthContext,
    @Param('docType') docType: string,
    @Param('id', new ZodPipe(z.uuid())) id: string,
  ) {
    return this.run(() =>
      this.database.withTenant(auth, async (tx) => {
        const t = await loadDocType(tx, docType);
        if (!t.isActive) throw new ConflictException('this document type is inactive');
        const [cur] = await tx.db
          .select()
          .from(document)
          .where(and(eq(document.id, id), eq(document.docType, docType)))
          .for('update');
        if (!cur) throw new NotFoundException();
        if (cur.status !== 'cancelled')
          throw new ConflictException('only a cancelled document can be amended');
        const [again] = await tx.db
          .select({ id: document.id })
          .from(document)
          .where(eq(document.amendedFrom, id));
        if (again) throw new ConflictException('this document was already amended');
        const lines = await tx.db
          .select()
          .from(documentLine)
          .where(eq(documentLine.documentId, id))
          .orderBy(documentLine.lineNo);
        const input = {
          companyId: cur.companyId,
          postingDate: cur.postingDate,
          currency: cur.currency.trim(),
          partyId: cur.partyId ?? undefined,
          values: cur.ext as Record<string, unknown>,
          lines: t.def.lines
            ? lines.map((l) => ({
                qty: l.qty,
                uom: l.uom,
                unitPrice: l.unitPrice ?? undefined,
                discount: l.discount,
                values: l.ext as Record<string, unknown>,
              }))
            : undefined,
        };
        const newId = await insertDraft(tx, auth, docType, t.def, input, id);
        return view(tx, auth, docType, newId);
      }),
    );
  }

  /** Database refusals carry business messages (locked period, issued document): report them as conflicts. */
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isPgError(e, 'P0001')) throw new ConflictException((e as Error).message);
      if (isPgError(e, '23503'))
        throw new BadRequestException('references something that does not exist (company, party)');
      throw e;
    }
  }
}

function parse<S extends z.ZodType>(schema_: S, body: unknown): z.infer<S> {
  const r = schema_.safeParse(body);
  if (!r.success) {
    throw new BadRequestException({
      message: 'validation failed',
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

type Input = z.infer<ReturnType<typeof documentInputSchema>>;

async function insertDraft(
  tx: Tx,
  auth: AuthContext,
  docType: string,
  def: DocTypeDef,
  input: Input,
  amendedFrom: string | null,
): Promise<string> {
  // The series is the type's own, one per company. Numbers advance only inside submit.
  await tx.db
    .insert(numberSeries)
    .values({
      tenantId: auth.tenantId,
      companyId: input.companyId,
      code: docType,
      prefix: def.numbering.prefix,
    })
    .onConflictDoNothing();
  const id = uuidv7();
  await tx.db.insert(document).values({
    tenantId: auth.tenantId,
    id,
    companyId: input.companyId,
    docType,
    seriesCode: docType,
    postingDate: input.postingDate,
    partyId: input.partyId ?? null,
    currency: input.currency,
    ext: input.values,
    amendedFrom,
  });
  if (input.lines) await insertLines(tx, auth, id, input.companyId, input.lines);
  return id;
}

async function insertLines(
  tx: Tx,
  auth: AuthContext,
  documentId: string,
  companyId: string,
  lines: NonNullable<Input['lines']>,
): Promise<void> {
  let n = 0;
  for (const l of lines) {
    n += 1;
    await tx.db.insert(documentLine).values({
      tenantId: auth.tenantId,
      id: uuidv7(),
      companyId,
      documentId,
      lineNo: n,
      qty: l.qty,
      uom: l.uom,
      baseQty: l.qty, // no item conversion in metadata-only types
      unitPrice: l.unitPrice ?? null,
      discount: l.discount ?? '0',
      ext: l.values,
    });
  }
}

/** `party` fields are references inside ext, which no foreign key covers: check them here. */
async function checkParties(
  tx: Tx,
  def: DocTypeDef,
  values: Record<string, unknown>,
  partyId: string | undefined,
): Promise<void> {
  const ids = new Set<string>(partyId ? [partyId] : []);
  for (const f of def.fields)
    if (f.type === 'party' && typeof values[f.name] === 'string') ids.add(values[f.name] as string);
  for (const id of ids) {
    const [p] = await tx.db.select({ id: party.id }).from(party).where(eq(party.id, id));
    if (!p)
      throw new BadRequestException({
        message: 'validation failed',
        issues: [{ path: 'party', message: `unknown party ${id}` }],
      });
  }
}

async function countLines(tx: Tx, id: string): Promise<number> {
  return (
    await tx.db
      .select({ id: documentLine.id })
      .from(documentLine)
      .where(eq(documentLine.documentId, id))
  ).length;
}

function validateForSubmit(
  def: DocTypeDef,
  row: DocRow,
  lines: number,
): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  const r = valuesSchema(def.fields).safeParse(row.ext);
  if (!r.success)
    for (const i of r.error.issues)
      out.push({ path: `values.${i.path.join('.')}`, message: i.message });
  if (def.requiresParty && !row.partyId)
    out.push({ path: 'partyId', message: 'a party is required' });
  if (def.lines && lines < def.lines.minLines)
    out.push({ path: 'lines', message: `at least ${def.lines.minLines} line(s) required` });
  return out;
}

const summary = (d: DocRow) => ({
  id: d.id,
  number: d.number,
  status: d.status,
  postingDate: d.postingDate,
  partyId: d.partyId,
  companyId: d.companyId,
  currency: d.currency.trim(),
  version: d.version,
  values: d.ext as Record<string, unknown>,
});

async function view(tx: Tx, auth: AuthContext, docType: string, id: string) {
  const [d] = await tx.db
    .select()
    .from(document)
    .where(and(eq(document.id, id), eq(document.docType, docType)));
  if (!d) throw new NotFoundException();
  const lines = await tx.db
    .select()
    .from(documentLine)
    .where(eq(documentLine.documentId, id))
    .orderBy(documentLine.lineNo);
  const [amended] = await tx.db
    .select({ id: document.id })
    .from(document)
    .where(eq(document.amendedFrom, id));
  const can = (a: string) => auth.permissions.has(`${docType}:${a}`);
  const actions: string[] = [];
  if (d.status === 'draft') {
    if (can('update')) actions.push('update', 'delete');
    if (can('submit')) actions.push('submit');
  } else if (d.status === 'submitted') {
    if (can('cancel') && !d.issuedAt) actions.push('cancel');
  } else if (can('amend') && !amended) {
    actions.push('amend');
  }
  return {
    ...summary(d),
    docType,
    amendedFrom: d.amendedFrom,
    amendedBy: amended?.id ?? null,
    partySnapshot: d.partySnapshot,
    submittedAt: d.submittedAt,
    lines: lines.map((l) => ({
      lineNo: l.lineNo,
      qty: l.qty,
      uom: l.uom,
      unitPrice: l.unitPrice,
      discount: l.discount,
      values: l.ext,
    })),
    actions,
  };
}
