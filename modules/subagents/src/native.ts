import { findCodexBinary, getCodexVersion, listFeatures } from "./kit/index.js";
import type { DoctorResult, NativeDetection, NativeFeatureState } from "./types.js";

const FEATURE_NAMES = ["multi_agent", "enable_fanout", "multi_agent_v2", "child_agents_md"] as const;

export type DetectNativeOptions = {
  bin?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
};

export function detectNative(opts: DetectNativeOptions = {}): NativeDetection {
  const bin = opts.bin ?? findCodexBinary(opts.env);
  if (!bin) {
    return {
      bin: null,
      features: FEATURE_NAMES.map(name => missingFeature(name)),
      error: "codex binary not found",
    };
  }

  try {
    const rawFeatures = listFeatures({ bin, env: opts.env });
    return {
      bin,
      features: FEATURE_NAMES.map(name => {
        const feature = rawFeatures.find(item => item.name === name);
        if (!feature) return missingFeature(name);
        const stage = feature.stage.toLowerCase();
        const stable = stage === "stable";
        const usable = name === "multi_agent" && stable && feature.enabled;
        return {
          name,
          stage: feature.stage,
          enabled: feature.enabled,
          supported: true,
          usable,
          note: usable
            ? "stable and enabled; native diagnostics available"
            : stable
              ? "stable but not enabled"
              : "under development; report only, do not enable by default",
        };
      }),
    };
  } catch (error) {
    return {
      bin,
      features: FEATURE_NAMES.map(name => missingFeature(name)),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function doctor(opts: DetectNativeOptions = {}): DoctorResult {
  const codexBinary = opts.bin ?? findCodexBinary(opts.env);
  const version = getCodexVersion(codexBinary)?.raw ?? null;
  const native = detectNative({ ...opts, bin: codexBinary ?? undefined });
  const recommendations = [
    "Use the exec runner as the default engine for predictable artifact-first orchestration.",
    "Keep agents.max_threads >= the desired native subagent fan-out plus one parent thread when using native diagnostics.",
    "Keep agents.max_depth = 1 unless recursive subagents are explicitly required.",
    "Treat enable_fanout, multi_agent_v2, and child_agents_md as report-only while they are under development.",
  ];
  return { codexBinary, version, native, recommendations };
}

function missingFeature(name: NativeFeatureState["name"]): NativeFeatureState {
  return {
    name,
    stage: null,
    enabled: false,
    supported: false,
    usable: false,
    note: "not reported by codex features list",
  };
}
