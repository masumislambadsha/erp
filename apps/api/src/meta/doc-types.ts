import { NotFoundException } from '@nestjs/common';
import { type DocTypeDef, DocTypeDef as DocTypeDefSchema, formModel, listModel } from '@erp/meta';
import { eq, schema, type Tx } from '@erp/db';

const { docTypeDef } = schema;

export interface LoadedDocType {
  id: string;
  docType: string;
  version: number;
  isActive: boolean;
  def: DocTypeDef;
}

/** Loads and re-validates a stored definition. The code is the path parameter, so check its shape first. */
export async function loadDocType(tx: Tx, code: string): Promise<LoadedDocType> {
  if (!/^[a-z][a-z_]*$/.test(code)) throw new NotFoundException();
  const [row] = await tx.db.select().from(docTypeDef).where(eq(docTypeDef.docType, code));
  if (!row) throw new NotFoundException();
  return {
    id: row.id,
    docType: row.docType,
    version: row.version,
    isActive: row.isActive,
    def: DocTypeDefSchema.parse(row.definition),
  };
}

export function describeDocType(t: LoadedDocType) {
  return {
    docType: t.docType,
    version: t.version,
    isActive: t.isActive,
    definition: t.def,
    form: formModel(t.def),
    list: listModel(t.def),
  };
}
