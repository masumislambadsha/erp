/** The queues the service uses. They are created by migration 0004; erp_app cannot create tables. */
export const QUEUES = {
  documentSubmitted: 'document.submitted',
  integrityNightly: 'integrity.nightly', // cron, handled by the supervisor: fans out one job per tenant
  integrityTenant: 'integrity.tenant', // handled by the workers
  maintenance: 'maintenance.jobs',
} as const;

export interface DocumentSubmittedJob {
  tenantId: string;
  docType: string;
  documentId: string;
  submittedBy: string;
}

export interface TenantIntegrityJob {
  tenantId: string;
  day: string; // YYYY-MM-DD in Asia/Dhaka
}
