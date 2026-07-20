// IPC contract for EndoSeg Review — shared between main process and renderer.

export const IPC = {
  // Annotator channels — same names as EndoSeg so AnnotatorCanvas.tsx needs no changes.
  segListFrames: "segmentation:listFrames",
  segLoad:       "segmentation:load",
  segSave:       "segmentation:save",
  // Reviewer-specific channels.
  reviewOpen:          "reviewer:openPackage",
  reviewSavePackage:   "reviewer:savePackage",
  reviewGetName:       "reviewer:getName",
  reviewSetName:       "reviewer:setName",
  reviewSetDecision:   "reviewer:setDecision",
  reviewGetDecisions:  "reviewer:getDecisions",
  reviewGetAutoOpen:   "reviewer:getAutoOpen",
} as const;

export interface SegFrame {
  frameId: string;
  name: string;
  url: string;
  width: number;
  height: number;
}

export interface SegFramesResult {
  source: "kept" | "raw" | "none";
  frames: SegFrame[];
}

export interface FrameDecision {
  status: "approved" | "rejected" | "edited" | "pending";
  comment?: string;
}

export interface OpenPackageResult {
  frames: SegFrame[];
  reviewerName: string | null;
  decisions: Record<string, FrameDecision>;
  /** Original zip path, shown in the title bar. */
  zipPath: string;
}

/** Annotator-compatible API surface exposed on window.endoseg by the preload. */
export interface ReviewerEndoSegApi {
  listSegFrames(projectId: string): Promise<SegFramesResult>;
  loadSegmentation(projectId: string): Promise<unknown | null>;
  saveSegmentation(projectId: string, snapshot: unknown): Promise<null>;
}

/** Reviewer-specific methods exposed on window.reviewerApi. */
export interface ReviewerApi {
  openPackage(): Promise<OpenPackageResult | null>;
  savePackage(): Promise<string | null>;
  getReviewerName(): Promise<string | null>;
  setReviewerName(name: string): Promise<void>;
  setDecision(frameId: string, status: FrameDecision["status"], comment?: string): Promise<void>;
  getDecisions(): Promise<Record<string, FrameDecision>>;
  /** Returns a pre-opened file path if app was launched by double-clicking a .endoseg file. */
  getAutoOpen(): Promise<string | null>;
}

declare global {
  interface Window {
    endoseg: ReviewerEndoSegApi;
    reviewerApi: ReviewerApi;
  }
}
