import { describe, it, expect } from "vitest";
import {
  PHASES,
  parsePhaseLabels,
  phaseAt,
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
} from "./phases.js";

describe("PHASES", () => {
  it("extracts frames for every phase except fluoroscopy, with unique keys", () => {
    expect(PHASES.filter((p) => !p.frames).map((p) => p.id)).toEqual(["fluoroscopy"]);
    expect(new Set(PHASES.map((p) => p.key)).size).toBe(PHASES.length);
  });
});

describe("parsePhaseLabels", () => {
  it("keeps valid spans sorted and drops malformed ones", () => {
    const r = parsePhaseLabels({
      spans: [
        { id: "b", phase: "cannulation-attempt", start: 20, end: 30 },
        { id: "a", phase: "duodenum", start: 0, end: 10 },
        { id: "x", phase: "sphincterotomy", start: 0, end: 5 }, // unknown phase
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

describe("naming", () => {
  it("names the case after the folder the video was in", () => {
    expect(caseNameFromSource("R:\\nas\\Raw ERCP Videos\\CASE_2026_01_02\\video.mp4")).toBe("CASE_2026_01_02");
    expect(caseNameFromSource("/mnt/raw/CASE B/video.avi")).toBe("CASE B");
    expect(caseNameFromSource("D:\\video.avi")).toBe("video");
  });

  it("builds <case>_<phase> folders and numbered clips", () => {
    expect(phaseFolderName("CASE", "cannulation-success")).toBe("CASE_cannulation-success");
    expect(phaseClipName("CASE", "cannulation-attempt", 2)).toBe("CASE_cannulation-attempt_02.mp4");
  });

  it("names frames so a sorted listing is chronological", () => {
    const a = phaseFrameName("CASE", "post-cannulation", 9.5);
    const b = phaseFrameName("CASE", "duodenum", 75);
    expect(a).toBe("CASE_t00009500_post-cannulation.png");
    expect([b, a].sort()).toEqual([a, b]);
    expect(phaseFrameName("CASE A", "duodenum", 0)).toBe("CASE_A_t00000000_duodenum.png");
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

  it("only plays H.264/VP9/AV1 in mp4-family containers directly", () => {
    expect(isBrowserPlayable("video.mp4", "h264")).toBe(true);
    expect(isBrowserPlayable("video.MOV", "h264")).toBe(true);
    expect(isBrowserPlayable("video.avi", "h264")).toBe(false);
    expect(isBrowserPlayable("video.mp4", "hevc")).toBe(false);
    expect(isBrowserPlayable("video.mp4", "mpeg4")).toBe(false);
  });
});
