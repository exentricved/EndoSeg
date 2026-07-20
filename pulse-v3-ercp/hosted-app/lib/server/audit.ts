import type { HostedAuditEvent } from "@/lib/domain/models";
import { appendAuditEvent, listRecentAuditEvents as readRecentAuditEvents } from "@/lib/server/dev-db";

export async function recordAuditEvent({
  actorUserId = null,
  objectType,
  objectId,
  action,
  payload,
}: {
  actorUserId?: string | null;
  objectType: string;
  objectId: string;
  action: string;
  payload?: Record<string, unknown>;
}) {
  const event: HostedAuditEvent = {
    id: `audit_${Math.random().toString(36).slice(2, 10)}`,
    actorUserId,
    objectType,
    objectId,
    action,
    payload,
    eventTs: new Date().toISOString(),
  };

  await appendAuditEvent(event);

  return event;
}

export function listRecentAuditEvents() {
  return readRecentAuditEvents();
}
