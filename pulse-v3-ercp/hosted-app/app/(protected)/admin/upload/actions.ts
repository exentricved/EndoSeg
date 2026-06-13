"use server";

import { redirect } from "next/navigation";

import { requireRole } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/server/audit";
import { createCaseFromUploadedPackage } from "@/lib/server/mock-store";
import { validateCasePackageInput } from "@/lib/validation/case-package";

export async function validateCasePackageAction(formData: FormData) {
  const session = await requireRole(["admin"]);

  const manifest = formData.get("manifest");
  const assetCandidates = formData.getAll("assets");
  const manifestFile = manifest instanceof File ? manifest : null;
  const assetFiles = assetCandidates.filter((value): value is File => value instanceof File);
  const result = validateCasePackageInput({
    manifestFile,
    assetFiles,
  });

  if (!result.ok || !manifestFile) {
    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "case_package",
      objectId: result.inferredCaseKey || "unknown",
      action: "case_package_validation_failed",
      payload: {
        ok: result.ok,
        manifestName: result.manifestName,
        assetCount: result.assetCount,
        messages: result.messages,
      },
    });

    const invalidParams = new URLSearchParams();
    invalidParams.set("validated", "0");
    invalidParams.set("manifest", result.manifestName || "");
    invalidParams.set("assets", String(result.assetCount));
    invalidParams.set("caseKey", result.inferredCaseKey || "");
    invalidParams.set("message", result.messages.join(" | "));
    redirect(`/admin/upload?${invalidParams.toString()}`);
  }

  let created;
  try {
    created = await createCaseFromUploadedPackage({
      uploadedByUserId: session.userId,
      manifestFile,
      assetFiles,
    });
  } catch (error) {
    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "case_package",
      objectId: result.inferredCaseKey || "unknown",
      action: "case_package_parse_failed",
      payload: {
        manifestName: result.manifestName,
        assetCount: result.assetCount,
        error: error instanceof Error ? error.message : "Unknown parse error",
      },
    });

    const parseParams = new URLSearchParams();
    parseParams.set("validated", "0");
    parseParams.set("manifest", result.manifestName || "");
    parseParams.set("assets", String(result.assetCount));
    parseParams.set("caseKey", result.inferredCaseKey || "");
    parseParams.set("message", "Manifest JSON could not be parsed into a valid intake payload.");
    redirect(`/admin/upload?${parseParams.toString()}`);
  }

  await recordAuditEvent({
    actorUserId: session.userId,
    objectType: "case_package",
    objectId: created.case.id,
    action: "case_package_persisted",
    payload: {
      ok: result.ok,
      caseId: created.case.id,
      displayCaseId: created.case.displayCaseId,
      manifestName: result.manifestName,
      assetCount: result.assetCount,
      messages: result.messages,
    },
  });

  const params = new URLSearchParams();
  params.set("validated", result.ok ? "1" : "0");
  params.set("manifest", result.manifestName || "");
  params.set("assets", String(result.assetCount));
  params.set("caseKey", created.case.id);
  params.set("displayCaseId", created.case.displayCaseId);
  params.set("message", result.messages.join(" | "));

  redirect(`/admin/upload?${params.toString()}`);
}
