export interface StructuredOutputRequest<TSchema> {
  schemaName: string;
  prompt: string;
  input: unknown;
  schema?: TSchema;
}

export class ModelAdapter {
  get configured(): boolean {
    return Boolean(process.env.MODEL_API_KEY && process.env.MODEL_BASE_URL);
  }

  async analyzeText(prompt: string, input: unknown): Promise<{ text: string; confidence: number }> {
    return {
      text: `Local scaffold analysis. Prompt: ${prompt.slice(0, 80)}. Input keys: ${Object.keys((input as object) ?? {}).join(", ")}`,
      confidence: this.configured ? 0.65 : 0.35
    };
  }

  async analyzeImages(imagePaths: string[], prompt: string): Promise<{ notes: string[]; confidence: number }> {
    return {
      notes: imagePaths.map((imagePath) => `待视觉模型分析：${imagePath}`).concat(prompt ? [`分析目标：${prompt}`] : []),
      confidence: this.configured ? 0.6 : 0.25
    };
  }

  async analyzeVideoFrames(framePaths: string[], prompt: string): Promise<{ notes: string[]; confidence: number }> {
    return this.analyzeImages(framePaths, prompt);
  }

  async structuredOutput<T>(request: StructuredOutputRequest<unknown>, fallback: T): Promise<T> {
    void request;
    return fallback;
  }
}
