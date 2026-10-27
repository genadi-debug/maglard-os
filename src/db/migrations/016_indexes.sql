-- Indexes for the lookups the screens make by parent record, so the lists stay
-- quick as apartments, requests and invoices add up.
CREATE INDEX IF NOT EXISTS service_request_events_by_request ON service_request_events (service_request_id, created_at);
CREATE INDEX IF NOT EXISTS service_requests_by_engagement ON service_requests (engagement_id);
CREATE INDEX IF NOT EXISTS service_requests_open ON service_requests (created_at) WHERE status <> 'closed';
CREATE INDEX IF NOT EXISTS supplier_invoices_by_engagement ON supplier_invoices (engagement_id);
CREATE INDEX IF NOT EXISTS engagements_by_client ON engagements (client_id);
CREATE INDEX IF NOT EXISTS engagements_by_property ON engagements (property_id);
CREATE INDEX IF NOT EXISTS tasks_by_engagement ON tasks (engagement_id);
