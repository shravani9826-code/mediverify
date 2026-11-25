import { ai } from '../lib/firebase';
import { Type } from '@google/genai';

export interface ExtractedMedicine {
  name: string;
  dosage: string;
  schedule: string[];
  expiryDate?: string;
  notes?: string;
}

export async function extractMedicineInfo(file: File): Promise<ExtractedMedicine[]> {
  const base64Data = await fileToBase64(file);
  const mimeType = file.type;

  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: [
      {
        parts: [
          {
            text: "Extract medicine details from this document. Identify the medicine name, dosage, schedule/frequency (e.g. ['08:00', '20:00']), and expiry date if visible. Return the data in a structured JSON array."
          },
          {
            inlineData: {
              data: base64Data,
              mimeType: mimeType
            }
          }
        ]
      }
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            dosage: { type: Type.STRING },
            schedule: { 
              type: Type.ARRAY, 
              items: { type: Type.STRING },
              description: "Array of 24h formatted times"
            },
            expiryDate: { type: Type.STRING },
            notes: { type: Type.STRING }
          },
          required: ["name", "dosage", "schedule"]
        }
      }
    }
  });

  try {
    return JSON.parse(response.text || '[]');
  } catch (err) {
    console.error("Failed to parse Gemini response:", err);
    return [];
  }
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      resolve(base64);
    };
    reader.onerror = error => reject(error);
  });
}
