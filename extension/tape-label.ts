export function shortTapeTitle(pageTitle: string): string {
  return pageTitle.split(/\s+[|·]\s+/)[0].trim() || "Untitled article";
}
