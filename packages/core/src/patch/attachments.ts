import { isAttachment, validateMetadataProperties } from "./metadata.js";
import type { Attachment, Material, PatchContent } from "./model.js";

/** Direct metadata Attachments are dependencies; opaque JSON is not traversed. */
export function materialAttachments(material: Pick<Material, "content" | "meta">): readonly Attachment[] {
  return [material.content, ...Object.values(material.meta).filter(isAttachment)];
}

/** Include authored metadata even if a later contribution masks it in the resolved graph. */
export function contentAttachments(content: PatchContent): readonly Attachment[] {
  const properties = [content.metadata.properties];
  for (const operation of content.delta.operations)
    if (operation.kind === "add-metadata-set") properties.push(operation.metadataSet.properties);
  return [
    ...content.delta.operations.flatMap((operation) =>
      operation.kind === "add-material" || operation.kind === "edit-material"
        ? materialAttachments(operation.material)
        : [],
    ),
    ...properties.flatMap((entries) => {
      validateMetadataProperties(entries);
      return Object.values(entries).filter(isAttachment);
    }),
  ];
}
