/** The queues the service uses. They are created by migration 0004; erp_app cannot create tables. */
export const QUEUES = {
  documentSubmitted: 'document.submitted',
  integrityNightly: 'integrity.nightly',
  maintenance: 'maintenance.jobs',
} as const;

export interface DocumentSubmittedJob {
  tenantId: string;
  docType: string;
  documentId: string;
  submittedBy: string;
}

export interface NightlyJob {
  day: string; // YYYY-MM-DD in Asia/Dhaka
}
