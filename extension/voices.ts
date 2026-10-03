export type FishVoice = { id: string; name: string; languages: string[] };
export type VoicePage = { voices: FishVoice[]; hasMore: boolean };

export const DEFAULT_VOICE: FishVoice = {
  id: "b347db033a6549378b48d00acb0d06cd",
  name: "Selene",
  languages: ["en"],
};

export function isFishVoice(value: unknown): value is FishVoice {
  if (!value || typeof value !== "object") return false;
  const voice = value as Partial<FishVoice>;
  return typeof voice.id === "string" && /^[a-f0-9]{24,64}$/.test(voice.id)
    && typeof voice.name === "string" && voice.name.length > 0 && voice.name.length <= 200
    && Array.isArray(voice.languages) && voice.languages.every((language) => typeof language === "string");
}
