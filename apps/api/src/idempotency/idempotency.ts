import { SetMetadata } from '@nestjs/common';

const KEY = 'erp:idempotent';
export const IDEMPOTENT_KEY = KEY;
/** A POST or PATCH that must carry an Idempotency-Key header: a retry replays the first answer. */
export const Idempotent = () => SetMetadata(KEY, true);
