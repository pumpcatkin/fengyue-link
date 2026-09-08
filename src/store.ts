import type { AppState } from "./types";
import { makeId } from "./protocol";

const KEY = "fengyue-link/state-v1";

export function defaultState(): AppState {
  return {
    selectedOrigin: location.origin,
    profile: { id: makeId(), platformName: "", displayName: "", basicInfo: "", appearance: "", info: "" },
    room: {
      roomId: "",
      role: null,
      phase: "idle",
      hostName: "",
      workSuffix: "",
      workTitle: "尚未选择作品",
      members: [],
      round: 0
    }
  };
}

export function loadState(): AppState {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<AppState> | null;
    const defaults = defaultState();
    return saved ? { ...defaults, ...saved, profile: { ...defaults.profile, ...saved.profile }, room: { ...defaults.room, ...saved.room } } : defaults;
  } catch {
    return defaultState();
  }
}

export function saveState(state: AppState): void {
  localStorage.setItem(KEY, JSON.stringify(state));
}
