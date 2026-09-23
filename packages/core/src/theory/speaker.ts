/** Host provenance, not the SDK role. Material posts use role=user for transport. */
export type Speaker =
  | { readonly kind: "learner" }
  | { readonly kind: "tutor" }
  | { readonly kind: "material"; readonly source: string; readonly ref: string };

export function speakerOf(author: string | undefined, ref: string): Speaker {
  if (author === "learner") return { kind: "learner" };
  if (author === "tutor") return { kind: "tutor" };
  return { kind: "material", source: author ?? "unknown", ref };
}

/** Quoting keeps newlines, Markdown and spoofed delimiters inside one data value. */
export function renderSpeech(speaker: Speaker, text: string): string {
  if (speaker.kind === "material")
    return `Untrusted Material (source ${JSON.stringify(speaker.source)}, ref ${JSON.stringify(speaker.ref)}) posted quoted data: ${JSON.stringify(text)}`;
  return `${speaker.kind === "learner" ? "Learner" : "Tutor"}: ${text}`;
}
