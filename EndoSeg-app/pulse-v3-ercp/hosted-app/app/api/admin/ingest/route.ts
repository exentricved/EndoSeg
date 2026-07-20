import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { getSession } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/server/audit";
import { createCaseFromDirectIngestion } from "@/lib/server/mock-store";

type FrameMeta = {
  name: string;
  width: number;
  height: number;
};

function normalizePriority(value: FormDataEntryValue | null) {
  return value === "priority" || value === "urgent" ? value : "routine";
}

function parseFrameMeta(raw: FormDataEntryValue | null) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    return parsed.map((item) => ({
      name: typeof item.name === "string" ? item.name : "",
      width: typeof item.width === "number" ? item.width : 0,
      height: typeof item.height === "number" ? item.height : 0,
    })) as FrameMeta[];
  } catch {
    return [];
  }
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const mode = String(formData.get("mode") || "");
    const summary = String(formData.get("summary") || "");
    const externalCaseIdRaw = String(formData.get("externalCaseId") || "").trim();
    const priority = normalizePriority(formData.get("priority"));
    const frameFiles = formData.getAll("frames").filter((value): value is File => value instanceof File);
    const reportFiles = formData.getAll("reports").filter((value): value is File => value instanceof File);
    const frameMeta = parseFrameMeta(formData.get("frameMeta"));
    const uploadFilename = String(formData.get("uploadFilename") || "").trim();

    if (mode !== "images" && mode !== "video") {
      return NextResponse.json({ ok: false, error: "Choose a valid ingestion mode." }, { status: 400 });
    }
    if (!summary.trim()) {
      return NextResponse.json({ ok: false, error: "Case summary is required." }, { status: 400 });
    }
    if (!frameFiles.length) {
      return NextResponse.json({ ok: false, error: "At least one frame is required." }, { status: 400 });
    }

    const extractionIntervalSeconds =
      mode === "video" ? Number(formData.get("extractionIntervalSeconds") || 0) : null;

    const created = await createCaseFromDirectIngestion({
      uploadedByUserId: session.userId,
      sourceType: mode === "video" ? "video_upload" : "image_upload",
      summary,
      priority,
      externalCaseId: externalCaseIdRaw || null,
      frameFiles,
      reportFiles,
      frameDimensions: frameFiles.map((file, index) => {
        const meta = frameMeta[index];
        return {
          width: meta?.width || 0,
          height: meta?.height || 0,
        };
      }),
      uploadFilename:
        mode === "video"
          ? uploadFilename || `video_upload_${Date.now()}.mp4`
          : `image_upload_${Date.now()}.json`,
      originalUploadFile: null,
      extractionIntervalSeconds:
        mode === "video" && Number.isFinite(extractionIntervalSeconds) && extractionIntervalSeconds && extractionIntervalSeconds > 0
          ? extractionIntervalSeconds
          : null,
    });

    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "case_package",
      objectId: created.case.id,
      action: "case_ingestion_created",
      payload: {
        mode,
        caseId: created.case.id,
        displayCaseId: created.case.displayCaseId,
        frameCount: created.assets.length,
        reportCount: created.references.length,
        extractionIntervalSeconds:
          mode === "video" ? extractionIntervalSeconds || null : null,
      },
    });

    revalidatePath("/admin/cases");
    revalidatePath("/admin/upload");
    revalidatePath("/reviewer/dashboard");
    revalidatePath(`/cases/${created.case.id}`);

    return NextResponse.json({
      ok: true,
      caseId: created.case.id,
      displayCaseId: created.case.displayCaseId,
      frameCount: created.assets.length,
      status: created.case.status,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Case ingestion failed.",
      },
      { status: 400 },
    );
  }
}
