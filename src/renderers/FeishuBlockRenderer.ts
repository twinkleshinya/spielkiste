import { DocumentModel } from "../schemas/index.js";

export class FeishuBlockRenderer {
  toBlocks(document: DocumentModel): Array<Record<string, unknown>> {
    return document.blocks;
  }
}
