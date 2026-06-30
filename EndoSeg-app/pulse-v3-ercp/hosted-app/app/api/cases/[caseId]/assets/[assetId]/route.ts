import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import { canUserAccessCase, getCaseBundle, readObjectArtifact, resolveCaseAsset } from "@/lib/server/mock-store";

function contentTypeFor(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

function placeholderSvg(label: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#efe8dc"/>
  <rect x="36" y="36" width="1208" height="648" rx="28" fill="#fffaf2" stroke="#d6ccb9" stroke-width="3"/>
  <text x="640" y="312" text-anchor="middle" font-family="Georgia, serif" font-size="34" fill="#2b2520">Hosted Dev Asset Placeholder</text>
  <text x="640" y="370" text-anchor="middle" font-family="Georgia, serif" font-size="22" fill="#6f6253">${label}</text>
</svg>`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ caseId: string; assetId: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { caseId, assetId } = await params;
  const bundle = await getCaseBundle(caseId);
  if (!bundle || !canUserAccessCase(bundle, session.userId, session.role)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const asset = await resolveCaseAsset(caseId, assetId);
  if (!asset) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const buffer = await readObjectArtifact(asset.storageKey);
  if (!buffer) {
    return new NextResponse(placeholderSvg(asset.sourceName), {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  return new NextResponse(buffer, {
    headers: {
      "content-type": contentTypeFor(asset.sourceName),
      "cache-control": "no-store",
    },
  });
}
