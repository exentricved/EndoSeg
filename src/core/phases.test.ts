import { describe, it, expect } from "vitest";
import {
  PHASES,
  MANEUVERS,
  SUCCESS_KEY,
  parsePhaseLabels,
  phaseAt,
  maneuversAt,
  successfulAttempt,
  frameTimeKey,
  caseNameFromSource,
  phaseFolderName,
  phaseClipName,
  phaseFrameName,
  numberSpans,
  formatTimecode,
  buildClipArgs,
  buildPhaseFrameArgs,
  isBrowserPlayable,
  safeFolderName,
  normalizeCrop,
} from "./phases.js";

describe("PHASES", () => {
  it("extracts frames for every phase except fluoroscopy, with unique keys", () => {
    expect(PHASES.filter((p) => !p.frames).map((p) => p.id)).toEqual(["fluoroscopy"]);
    expect(new Set(PHASES.map((p) => p.key)).size).toBe(PHASES.length);
  });

  it("gives phases, maneuvers and the success marker distinct keys", () => {
    const keys = [...PHASES.map((p) => p.key), ...MANEUVERS.map((m) => m.key), SUCCESS_KEY];
    expect(new Set(keys).size).toBe(keys.length);
    expect(PHASES.map((p) => p.id)).not.toContain("cannulation-success");
  });
});

describe("parsePhaseLabels", () => {
  it("keeps valid spans sorted and drops malformed ones", () => {
    const r = parsePhaseLabels({
      spans: [
        { id: "b", phase: "cannulation-attempt", start: 20, end: 30 },
        { id: "a", phase: "duodenum", start: 0, end: 10 },
        { id: "x", phase: "papillotomy", start: 0, end: 5 }, // unknown phase
        { id: "y", phase: "duodenum", start: 5, end: 5 }, // empty
        { id: "z", phase: "duodenum", start: -1, end: 2 }, // negative
        { phase: "fluoroscopy", start: "40", end: "50" }, // numeric strings, no id
        "junk",
      ],
    });
    expect(r.spans.map((s) => [s.phase, s.start, s.end])).toEqual([
      ["duodenum", 0, 10],
      ["cannulation-attempt", 20, 30],
      ["fluoroscopy", 40, 50],
    ]);
    expect(r.spans[2]!.id).toBeTruthy();
  });

  it("keeps maneuvers and the success moment", () => {
    const r = parsePhaseLabels({
      cannulationSuccess: 42.5,
      spans: [{ id: "m", phase: "sphincterotomy", start: 50, end: 60 }],
    });
    expect(r.cannulationSuccess).toBe(42.5);
    expect(r.spans[0]!.phase).toBe("sphincterotomy");
  });

  it("turns an old cannulation-success span into the success moment plus post-cannulation", () => {
    const r = parsePhaseLabels({
      spans: [
        { id: "a", phase: "cannulation-attempt", start: 10, end: 30 },
        { id: "s", phase: "cannulation-success", start: 30, end: 45 },
      ],
    });
    expect(r.spans.map((s) => [s.id, s.phase, s.start, s.end])).toEqual([
      ["a", "cannulation-attempt", 10, 30],
      ["s", "post-cannulation", 30, 45],
    ]);
    expect(r.cannulationSuccess).toBe(30);
  });

  it("is empty for junk", () => {
    expect(parsePhaseLabels(null)).toEqual({ version: 1, spans: [] });
    expect(parsePhaseLabels({ spans: "no" }).spans).toEqual([]);
  });
});

describe("phaseAt", () => {
  it("finds the covering span, preferring the later-starting one on overlap", () => {
    const spans = parsePhaseLabels({
      spans: [
        { id: "a", phase: "pre-cannulation", start: 0, end: 60 },
        { id: "b", phase: "fluoroscopy", start: 30, end: 40 },
      ],
    }).spans;
    expect(phaseAt(spans, 10)?.id).toBe("a");
    expect(phaseAt(spans, 35)?.id).toBe("b");
    expect(phaseAt(spans, 60)).toBeUndefined();
  });
});

describe("maneuvers and success", () => {
  const spans = parsePhaseLabels({
    spans: [
      { id: "a1", phase: "cannulation-attempt", start: 10, end: 20 },
      { id: "a2", phase: "cannulation-attempt", start: 25, end: 30 },
      { id: "pc", phase: "post-cannulation", start: 30, end: 90 },
      { id: "m1", phase: "sphincterotomy", start: 40, end: 50 },
      { id: "m2", phase: "pancreatic-stent", start: 45, end: 60 },
    ],
  }).spans;

  it("lists the maneuvers under way, allowing overlap", () => {
    expect(maneuversAt(spans, 47)).toEqual(["sphincterotomy", "pancreatic-stent"]);
    expect(maneuversAt(spans, 55)).toEqual(["pancreatic-stent"]);
    expect(maneuversAt(spans, 70)).toEqual([]);
  });

  it("ignores maneuvers when finding the phase", () => {
    expect(phaseAt(spans, 47)?.id).toBe("pc");
  });

  it("credits success to the last attempt starting before it", () => {
    expect(successfulAttempt(spans, 30)?.id).toBe("a2");
    expect(successfulAttempt(spans, 22)?.id).toBe("a1");
    expect(successfulAttempt(spans, 5)).toBeUndefined();
    expect(successfulAttempt(spans, undefined)).toBeUndefined();
  });
});

describe("naming", () => {
  it("names the case after the folder the video was in", () => {
    expect(caseNameFromSource("R:\\nas\\Raw ERCP Videos\\CASE_2026_01_02\\video.mp4")).toBe("CASE_2026_01_02");
    expect(caseNameFromSource("/mnt/raw/CASE B/video.avi")).toBe("CASE B");
    expect(caseNameFromSource("D:\\video.avi")).toBe("video");
  });

  it("builds <case>_<phase> folders and numbered clips", () => {
    expect(phaseFolderName("CASE", "sphincterotomy")).toBe("CASE_sphincterotomy");
    expect(phaseClipName("CASE", "cannulation-attempt", 2, 17.25, 24)).toBe(
      "CASE_cannulation-attempt_02_t00017250-00024000.mp4",
    );
  });

  it("names frames by time and span number, so a sorted listing is chronological", () => {
    const a = phaseFrameName("CASE", "cannulation-attempt", 2, 9.5);
    const b = phaseFrameName("CASE", "duodenum", 1, 75);
    expect(a).toBe("CASE_t00009500_cannulation-attempt_02.png");
    expect([b, a].sort()).toEqual([a, b]);
    expect(phaseFrameName("CASE A", "duodenum", 1, 0)).toBe("CASE_A_t00000000_duodenum_01.png");
  });

  it("adds success and maneuvers to names, keeping the time key", () => {
    expect(phaseClipName("CASE", "cannulation-attempt", 3, 25, 30, { success: true })).toBe(
      "CASE_cannulation-attempt_03_success_t00025000-00030000.mp4",
    );
    const f = phaseFrameName("CASE", "post-cannulation", 1, 47, { maneuvers: ["sphincterotomy", "pancreatic-stent"] });
    expect(f).toBe("CASE_t00047000_post-cannulation_01_sphincterotomy_pancreatic-stent.png");
    expect(frameTimeKey(f)).toBe("00047000");
    expect(frameTimeKey("CASE_t00047000_post-cannulation_01.png")).toBe("00047000");
    expect(frameTimeKey("frame_000123.png")).toBeNull();
  });

  it("strips characters Windows can't put in a folder name", () => {
    expect(safeFolderName('a<b>:c"d|e?f*')).toBe("a_b_c_d_e_f_");
    expect(safeFolderName("trailing. ")).toBe("trailing");
    expect(safeFolderName("")).toBe("video");
  });

  it("numbers spans per phase in time order", () => {
    const spans = parsePhaseLabels({
      spans: [
        { id: "2", phase: "cannulation-attempt", start: 50, end: 60 },
        { id: "1", phase: "cannulation-attempt", start: 10, end: 20 },
        { id: "3", phase: "duodenum", start: 0, end: 5 },
      ],
    }).spans;
    expect(numberSpans(spans).map(({ span, index }) => `${span.id}:${index}`)).toEqual(["3:1", "1:1", "2:2"]);
  });

  it("formats timecodes", () => {
    expect(formatTimecode(0)).toBe("0:00.0");
    expect(formatTimecode(75.25)).toBe("1:15.3");
    expect(formatTimecode(3725)).toBe("1:02:05.0");
  });
});

describe("normalizeCrop", () => {
  it("clamps into the frame and rounds to even numbers", () => {
    expect(normalizeCrop({ x: 11, y: 5.6, w: 301, h: 2000 }, 1920, 1080)).toEqual({ x: 10, y: 4, w: 300, h: 1076 });
    expect(normalizeCrop({ x: -50, y: 0, w: 640, h: 360 }, 1920, 1080)).toEqual({ x: 0, y: 0, w: 640, h: 360 });
  });

  it("is null for no crop, a tiny box, the whole frame or junk", () => {
    expect(normalizeCrop(null, 1920, 1080)).toBeNull();
    expect(normalizeCrop({ x: 0, y: 0, w: 10, h: 500 }, 1920, 1080)).toBeNull();
    expect(normalizeCrop({ x: 0, y: 0, w: 1920, h: 1080 }, 1920, 1080)).toBeNull();
    expect(normalizeCrop({ x: "a", y: 0, w: 100, h: 100 }, 1920, 1080)).toBeNull();
    expect(normalizeCrop({ x: 0, y: 0, w: 100, h: 100 }, 0, 0)).toBeNull();
  });
});

describe("ffmpeg args", () => {
  it("seeks before the input and limits duration for clips and frames", () => {
    const clip = buildClipArgs("in.avi", "out.mp4", 12.5, 20);
    expect(clip.slice(0, 7)).toEqual(["-hide_banner", "-ss", "12.500", "-i", "in.avi", "-t", "7.500"]);
    expect(clip).toContain("libx264");
    expect(clip.at(-1)).toBe("out.mp4");
    const frames = buildPhaseFrameArgs("in.avi", "f_%06d.png", 1, 4, 1);
    expect(frames).toContain("select=gte(t\\,selected_n/1)");
    expect(frames.at(-1)).toBe("f_%06d.png");
  });

  it("adds the crop to clips and after the frame selection", () => {
    const c = { x: 10, y: 20, w: 300, h: 200 };
    const clip = buildClipArgs("in", "out.mp4", 0, 1, c);
    expect(clip[clip.indexOf("-vf") + 1]).toBe("crop=300:200:10:20");
    expect(buildClipArgs("in", "out.mp4", 0, 1)).not.toContain("-vf");
    const frames = buildPhaseFrameArgs("in", "f_%06d.png", 0, 1, 1, c);
    expect(frames[frames.indexOf("-vf") + 1]).toBe("select=gte(t\\,selected_n/1),crop=300:200:10:20");
  });

  it("only plays H.264/VP9/AV1 in mp4-family containers directly", () => {
    expect(isBrowserPlayable("video.mp4", "h264")).toBe(true);
    expect(isBrowserPlayable("video.MOV", "h264")).toBe(true);
    expect(isBrowserPlayable("video.avi", "h264")).toBe(false);
    expect(isBrowserPlayable("video.mp4", "hevc")).toBe(false);
    expect(isBrowserPlayable("video.mp4", "mpeg4")).toBe(false);
  });
});
