import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { GoogleGenAI } from '@google/genai';
import firebaseConfig from '../../firebase-applet-config.json';

// Ensure storageBucket is correctly formatted if it's missing the protocol (though usually it handles it)
const app = initializeApp(firebaseConfig);

export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

// Initialize Gemini with the API key from environment
export const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
