import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgl';
import '@tensorflow/tfjs-backend-cpu';
import * as mobilenet from '@tensorflow-models/mobilenet';

let model: mobilenet.MobileNet | null = null;

export async function loadAIModel() {
  if (!model) {
    await tf.ready();
    model = await mobilenet.load({
      version: 2,
      alpha: 1.0
    });
  }
  return model;
}

export async function getEmbedding(imageElement: HTMLImageElement | HTMLCanvasElement | ImageData) {
  const net = await loadAIModel();
  // Get embeddings from the 'conv_preds' layer (the last layer before classification)
  const activation = net.infer(imageElement, true); 
  const data = await activation.data();
  // Clean up tensor
  activation.dispose();
  return Array.from(data);
}

export function cosineSimilarity(a: number[], b: number[]) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export const SIMILARITY_THRESHOLD = 0.85;
