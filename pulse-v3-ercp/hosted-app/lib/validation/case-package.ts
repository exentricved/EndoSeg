type CasePackageInput = {
  manifestFile: File | null;
  assetFiles: File[];
};

export type CasePackageValidationResult = {
  ok: boolean;
  manifestName: string | null;
  assetCount: number;
  inferredCaseKey: string | null;
  messages: string[];
};

function inferCaseKey(manifestName: string | null) {
  if (!manifestName) return null;
  return manifestName.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "_");
}

export function validateCasePackageInput({
  manifestFile,
  assetFiles,
}: CasePackageInput): CasePackageValidationResult {
  const messages: string[] = [];
  const manifestName = manifestFile?.name || null;

  if (!manifestFile) {
    messages.push("Manifest file is required.");
  } else if (!manifestFile.name.toLowerCase().endsWith(".json")) {
    messages.push("Manifest must be a JSON file.");
  } else {
    messages.push("Manifest file accepted.");
  }

  if (!assetFiles.length) {
    messages.push("At least one frame or image asset is required. PDF report files are optional.");
  } else {
    messages.push(`${assetFiles.length} asset file(s) received.`);
  }

  return {
    ok: Boolean(manifestFile && manifestFile.name.toLowerCase().endsWith(".json") && assetFiles.length > 0),
    manifestName,
    assetCount: assetFiles.length,
    inferredCaseKey: inferCaseKey(manifestName),
    messages,
  };
}
