import { extensionRuntime, RECONNECT_MESSAGE, sendExtensionMessage } from "./extension-runtime";
import { DEFAULT_VOICE, type FishVoice, type VoicePage } from "./voices";

type VoiceReply<T> = T & { error?: string };

const styles = `
  #voice-button {
    align-items: center;
    background: transparent;
    border: 1px solid #b0ae95;
    border-radius: 4px;
    box-shadow: none;
    color: #374239;
    display: inline-flex;
    font: 700 8px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    gap: 4px;
    justify-content: center;
    letter-spacing: .04em;
    min-height: 16px;
    max-width: 128px;
    min-width: 0;
    padding: 0 5px;
  }
  #voice-button:hover, #voice-button[aria-expanded="true"] { background: #d4d0b9; color: #202a26; }
  #voice-button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #voice-button::after { color: #697354; content: "▾"; flex: none; font-size: 9px; }
  #voice-panel {
    background: #20292c;
    border: 1px solid #65716e;
    border-radius: 9px;
    bottom: 12px;
    box-shadow: 0 14px 35px rgb(0 0 0 / 48%), inset 0 1px rgb(255 255 255 / 8%);
    box-sizing: border-box;
    color: #e6ebe3;
    display: flex;
    flex-direction: column;
    gap: 9px;
    left: 12px;
    max-height: min(330px, calc(100dvh - 70px));
    min-height: 0;
    padding: 12px;
    position: absolute;
    right: 12px;
    top: 47px;
    z-index: 4;
  }
  #voice-panel[hidden] { display: none; }
  .voice-head, .voice-toolbar, .voice-tabs, .voice-foot { align-items: center; display: flex; justify-content: space-between; }
  .voice-head { min-height: 22px; }
  .voice-heading { color: #dce9ac; font: 800 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .17em; }
  .voice-provider { color: #93a09b; font: 600 9px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #voice-close { appearance: none; background: transparent; border: 0; border-radius: 4px; box-shadow: none; color: #adb8b2; font-size: 16px; min-height: 23px; min-width: 24px; padding: 0; }
  #voice-search { appearance: none; background: #151d1f; border: 1px solid #485553; border-radius: 5px; box-sizing: border-box; color: #edf0ed; font: 500 11px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; min-height: 32px; outline: none; padding: 0 9px; width: 100%; }
  #voice-search::placeholder { color: #87938e; }
  #voice-search:focus { border-color: #d0df9b; box-shadow: 0 0 0 1px #d0df9b; }
  .voice-tabs { background: #171f21; border: 1px solid #3c4947; border-radius: 5px; gap: 3px; padding: 3px; }
  .voice-tab { appearance: none; background: transparent; border: 0; border-radius: 3px; box-shadow: none; color: #aab5ae; flex: 1; font-size: 9px; min-height: 25px; padding: 0 4px; }
  .voice-tab[aria-selected="true"] { background: #35413e; box-shadow: inset 0 0 0 1px #536158; color: #e4edc0; }
  #voice-list { display: flex; flex: 1 1 auto; flex-direction: column; gap: 4px; min-height: 48px; overflow: auto; overscroll-behavior: contain; padding-right: 2px; scrollbar-color: #53615d #20292c; scrollbar-width: thin; }
  .voice-row { align-items: center; background: #273234; border: 1px solid #3a4745; border-radius: 5px; display: flex; flex: none; gap: 7px; min-height: 40px; padding: 0 6px 0 8px; }
  .voice-row[data-selected="true"] { background: #303d36; border-color: #83906b; }
  .voice-monogram { align-items: center; background: #20292c; border: 1px solid #778277; border-radius: 50%; box-sizing: border-box; color: #dce9ac; display: inline-flex; flex: none; font: 700 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace; height: 25px; justify-content: center; width: 25px; }
  .voice-copy { flex: 1; min-width: 0; }
  .voice-select { appearance: none; background: transparent; border: 0; box-shadow: none; color: #e9eee7; display: block; font-size: 10px; min-height: 18px; overflow: hidden; padding: 0; text-align: left; text-overflow: ellipsis; white-space: nowrap; width: 100%; }
  .voice-language { color: #98a59c; display: block; font: 500 8px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; margin-top: 2px; }
  .voice-check { color: #dce9ac; font: 700 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .voice-star { appearance: none; background: transparent; border: 0; box-shadow: none; color: #9ea99f; font: 18px/1 Arial, sans-serif; min-height: 29px; min-width: 30px; padding: 0; }
  .voice-star[data-favorite="true"] { color: #dce9ac; }
  #voice-message { color: #b7c2ba; font-size: 10px; line-height: 1.4; margin: auto 2px; padding: 8px 2px; text-align: center; }
  #voice-message[data-error="true"] { color: #e9b8a7; }
  #voice-more { appearance: none; background: #293537; border: 1px solid #52605c; border-radius: 4px; box-shadow: none; color: #d6e3ab; font-size: 9px; min-height: 26px; padding: 0 8px; }
  .voice-foot { border-top: 1px solid #384441; color: #929f98; font: 500 8px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace; padding-top: 7px; }
  #voice-note { color: #9aa79d; }
  #voice-live { color: #dce9ac; }
  #voice-panel button:focus-visible { outline: 2px solid #d4e888; outline-offset: 2px; }
`;

export function createVoicePicker(shadow: ShadowRoot, dock: HTMLElement): {
  readonly ready: Promise<void>;
  readonly selectedVoice: FishVoice;
  close(returnFocus?: boolean): void;
} {
  const sheet = document.createElement("style");
  sheet.textContent = styles;
  shadow.append(sheet);

  const button = document.createElement("button");
  button.id = "voice-button";
  button.type = "button";
  button.title = "Choose a Fish Audio voice";
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-controls", "voice-panel");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = "<span>Voice · Selene</span>";
  const label = document.createElement("span");
  label.textContent = "Voice · Selene";
  button.replaceChildren(label);
  shadow.getElementById("tape-site")?.after(button);

  const panel = document.createElement("section");
  panel.id = "voice-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Choose a Fish Audio voice");
  panel.innerHTML = `
    <div class="voice-head">
      <span class="voice-heading">VOICE LIBRARY</span>
      <span class="voice-toolbar"><span class="voice-provider">FISH AUDIO</span><button id="voice-close" type="button" aria-label="Close voice library">×</button></span>
    </div>
    <input id="voice-search" type="search" placeholder="Find a voice…" aria-label="Search Fish Audio voices" autocomplete="off" />
    <div class="voice-tabs" role="tablist" aria-label="Voice lists">
      <button class="voice-tab" id="voice-favorites-tab" type="button" role="tab" aria-selected="true">★ Favorites</button>
      <button class="voice-tab" id="voice-all-tab" type="button" role="tab" aria-selected="false">All voices</button>
    </div>
    <div id="voice-list" role="list" aria-label="Available voices"></div>
    <p id="voice-message" role="status" hidden></p>
    <button id="voice-more" type="button" hidden>Load more voices</button>
    <div class="voice-foot"><span id="voice-note">Applies to your next listen</span><span id="voice-live">● READY</span></div>
  `;
  dock.append(panel);

  const list = panel.querySelector<HTMLDivElement>("#voice-list")!;
  const search = panel.querySelector<HTMLInputElement>("#voice-search")!;
  const message = panel.querySelector<HTMLParagraphElement>("#voice-message")!;
  const more = panel.querySelector<HTMLButtonElement>("#voice-more")!;
  const live = panel.querySelector<HTMLSpanElement>("#voice-live")!;
  const favoritesTab = panel.querySelector<HTMLButtonElement>("#voice-favorites-tab")!;
  const allTab = panel.querySelector<HTMLButtonElement>("#voice-all-tab")!;
  const favorites = new Map<string, FishVoice>([[DEFAULT_VOICE.id, DEFAULT_VOICE]]);
  let selected = DEFAULT_VOICE;
  let allVoices: FishVoice[] = [];
  let page = 0;
  let hasMore = false;
  let busy = false;
  let view: "favorites" | "all" = "favorites";
  let searchTimer = 0;
  let requestNumber = 0;
  let readyResolve!: () => void;
  const ready = new Promise<void>((resolve) => { readyResolve = resolve; });

  const setMessage = (text: string, error = false): void => {
    message.textContent = text;
    message.hidden = !text;
    message.dataset.error = String(error);
    list.hidden = Boolean(text);
    more.hidden = Boolean(text) || view !== "all" || !hasMore;
  };

  const render = (): void => {
    list.replaceChildren();
    if (view === "favorites" && !search.value.trim()) {
      for (const voice of favorites.values()) appendVoice(voice);
      setMessage(favorites.size ? "" : "No favorites yet. Use ☆ beside a voice to save it here.");
      more.hidden = true;
      return;
    }
    if (view === "all" && !search.value.trim()) {
      for (const voice of allVoices) appendVoice(voice);
      if (!allVoices.length && !busy) setMessage("Search Fish Audio’s voice library to find a voice.");
      else if (busy && !allVoices.length) setMessage("Tuning in to the voice library…");
      else setMessage("");
      more.hidden = !hasMore || busy;
      return;
    }
    const source = view === "favorites" ? [...favorites.values()] : allVoices;
    const filtered = source.filter((voice) => voice.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
    for (const voice of filtered) appendVoice(voice);
    if (!filtered.length && view === "favorites") setMessage("No matching favorites. Search all voices to find more.");
    else if (!filtered.length && busy) setMessage("Tuning in to the voice library…");
    else if (!filtered.length) setMessage("No voices found. Try another name.");
    else setMessage("");
    more.hidden = view !== "all" || !hasMore || busy;
  };

  function appendVoice(voice: FishVoice): void {
    const row = document.createElement("div");
    row.className = "voice-row";
    row.setAttribute("role", "listitem");
    row.dataset.selected = String(voice.id === selected.id);
    const monogram = document.createElement("span");
    monogram.className = "voice-monogram";
    monogram.setAttribute("aria-hidden", "true");
    monogram.textContent = voice.name.trim().charAt(0).toUpperCase();
    const copy = document.createElement("div");
    copy.className = "voice-copy";
    const choose = document.createElement("button");
    choose.className = "voice-select";
    choose.type = "button";
    choose.textContent = voice.name;
    choose.title = voice.name;
    choose.setAttribute("aria-pressed", String(voice.id === selected.id));
    choose.addEventListener("click", () => {
      selected = voice;
      label.textContent = `Voice · ${voice.name}`;
      button.title = `Voice: ${voice.name}`;
      row.dataset.selected = "true";
      void sendExtensionMessage({ type: "select_voice", voice }).catch(() => undefined);
      render();
      button.focus({ preventScroll: true });
      close();
    });
    copy.append(choose);
    if (voice.languages.length) {
      const languages = document.createElement("span");
      languages.className = "voice-language";
      languages.textContent = voice.languages.slice(0, 3).map((code) => code.toUpperCase()).join(" · ");
      copy.append(languages);
    }
    const star = document.createElement("button");
    star.className = "voice-star";
    star.type = "button";
    star.dataset.favorite = String(favorites.has(voice.id));
    star.textContent = favorites.has(voice.id) ? "★" : "☆";
    star.title = favorites.has(voice.id) ? "Remove from favorites" : "Add to favorites";
    star.setAttribute("aria-label", `${star.title}: ${voice.name}`);
    star.addEventListener("click", (event) => {
      event.stopPropagation();
      const favorite = !favorites.has(voice.id);
      if (favorite) favorites.set(voice.id, voice);
      else favorites.delete(voice.id);
      render();
      void sendExtensionMessage({ type: "favorite_voice", voice, favorite }).catch((error: unknown) => {
        if (favorite) favorites.delete(voice.id);
        else favorites.set(voice.id, voice);
        setMessage(error instanceof Error ? error.message : RECONNECT_MESSAGE, true);
        live.textContent = "● OFFLINE";
      });
    });
    row.append(monogram, copy);
    if (voice.id === selected.id) {
      const check = document.createElement("span");
      check.className = "voice-check";
      check.textContent = "ON DECK";
      row.append(check);
    }
    row.append(star);
    list.append(row);
  }

  const load = async (reset: boolean): Promise<void> => {
    if (busy) return;
    busy = true;
    live.textContent = "● LOADING";
    if (reset) {
      allVoices = [];
      page = 0;
      hasMore = false;
    }
    render();
    const current = ++requestNumber;
    try {
      const result = await sendExtensionMessage<VoiceReply<VoicePage>>({
        type: "list_voices",
        query: search.value.trim(),
        page: page + 1,
      });
      if (current !== requestNumber) return;
      if (result.error) throw new Error(result.error);
      const known = new Set(allVoices.map((voice) => voice.id));
      allVoices.push(...result.voices.filter((voice) => !known.has(voice.id)));
      for (const voice of result.voices) if (favorites.has(voice.id)) favorites.set(voice.id, voice);
      page += 1;
      hasMore = result.hasMore;
      live.textContent = "● READY";
      render();
    } catch (error) {
      if (current !== requestNumber) return;
      live.textContent = "● OFFLINE";
      setMessage(error instanceof Error ? error.message : RECONNECT_MESSAGE, true);
    } finally {
      if (current === requestNumber) {
        busy = false;
        more.hidden = view !== "all" || !hasMore;
      }
    }
  };

  const close = (returnFocus = false): void => {
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    window.clearTimeout(searchTimer);
    requestNumber += 1;
    busy = false;
    if (returnFocus) button.focus({ preventScroll: true });
  };

  const setView = (next: "favorites" | "all"): void => {
    view = next;
    favoritesTab.setAttribute("aria-selected", String(next === "favorites"));
    allTab.setAttribute("aria-selected", String(next === "all"));
    if (next === "all" && !allVoices.length) void load(true);
    else render();
    if (next === "all") search.focus({ preventScroll: true });
  };

  button.addEventListener("click", () => {
    const open = panel.hidden;
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) {
      if (view === "all" && !allVoices.length) void load(true);
      else render();
      search.focus({ preventScroll: true });
    }
  });
  panel.querySelector("#voice-close")!.addEventListener("click", () => close(true));
  favoritesTab.addEventListener("click", () => setView("favorites"));
  allTab.addEventListener("click", () => setView("all"));
  more.addEventListener("click", () => void load(false));
  search.addEventListener("input", () => {
    render();
    if (view === "all") {
      window.clearTimeout(searchTimer);
      requestNumber += 1;
      busy = false;
      searchTimer = window.setTimeout(() => void load(true), 260);
    }
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close(true);
    }
  });
  document.addEventListener("pointerdown", (event) => {
    const path = event.composedPath();
    if (!path.includes(panel) && !path.includes(button)) close();
  });
  window.addEventListener("resize", () => {
    if (!dock.isConnected) close();
  });

  void sendExtensionMessage<VoiceReply<{ selected: FishVoice; favorites: FishVoice[] }>>({ type: "voice_settings" })
    .then((settings) => {
      selected = settings.selected || DEFAULT_VOICE;
      favorites.clear();
      for (const voice of settings.favorites || [DEFAULT_VOICE]) favorites.set(voice.id, voice);
      label.textContent = `Voice · ${selected.name}`;
      button.title = `Voice: ${selected.name}`;
      readyResolve();
      render();
    })
    .catch(() => {
      live.textContent = "● OFFLINE";
      readyResolve();
      render();
    });

  return {
    ready,
    get selectedVoice() { return selected; },
    close,
  };
}
