import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import {
  canUserAccessCase,
  getCaseBundle,
  readObjectArtifact,
  resolveCaseReference,
} from "@/lib/server/mock-store";

function imagePlaceholder(label: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#efe8dc"/>
  <rect x="36" y="36" width="1208" height="648" rx="28" fill="#fffaf2" stroke="#d6ccb9" stroke-width="3"/>
  <text x="640" y="320" text-anchor="middle" font-family="Georgia, serif" font-size="34" fill="#2b2520">Hosted Reference Placeholder</text>
  <text x="640" y="376" text-anchor="middle" font-family="Georgia, serif" font-size="22" fill="#6f6253">${label}</text>
</svg>`;
}

function escapePdfText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function pdfPlaceholder(label: string) {
  const lines = [
    "BT",
    "/F1 24 Tf",
    "72 740 Td",
    `(${escapePdfText("AnnotateEUS Hosted Report Placeholder")}) Tj`,
    "0 -34 Td",
    "/F1 14 Tf",
    `(${escapePdfText(label)}) Tj`,
    "0 -24 Td",
    `(${escapePdfText("Replace this placeholder with the reviewer-facing PDF in the case package.")}) Tj`,
    "ET",
  ].join("\n");

  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
    "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    `5 0 obj << /Length ${Buffer.byteLength(lines, "utf8")} >> stream\n${lines}\nendstream endobj`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${object}\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ caseId: string; referenceId: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { caseId, referenceId } = await params;
  const bundle = await getCaseBundle(caseId);
  if (!bundle || !canUserAccessCase(bundle, session.userId, session.role)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const reference = await resolveCaseReference(caseId, referenceId);
  if (!reference) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (reference.textContent != null) {
    return new NextResponse(reference.textContent, {
      headers: {
        "content-type": reference.mimeType,
        "cache-control": "no-store",
      },
    });
  }

  if (!reference.storageKey) {
    return NextResponse.json({ error: "Reference storage missing" }, { status: 404 });
  }

  const buffer = await readObjectArtifact(reference.storageKey);
  if (!buffer) {
    if (reference.referenceKind === "pdf") {
      return new NextResponse(pdfPlaceholder(reference.sourceName), {
        headers: {
          "content-type": "application/pdf",
          "cache-control": "no-store",
        },
      });
    }

    if (reference.referenceKind === "image") {
      return new NextResponse(imagePlaceholder(reference.sourceName), {
        headers: {
          "content-type": "image/svg+xml; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    return new NextResponse(
      `Reference placeholder for ${reference.sourceName}. Upload a real file to replace this dev stub.`,
      {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  }

  return new NextResponse(buffer, {
    headers: {
      "content-type": reference.mimeType,
      "cache-control": "no-store",
    },
  });
}
