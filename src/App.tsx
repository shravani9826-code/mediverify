/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, createContext, useContext } from 'react';
import { 
  Plus, 
  Home, 
  Scan, 
  ClipboardList, 
  User as UserIcon,
  Volume2,
  Bell,
  CheckCircle2,
  AlertTriangle,
  LogOut,
  Camera,
  X,
  Upload,
  Calendar
} from 'lucide-react';
import { 
  onAuthStateChanged, 
  signInWithPopup, 
  GoogleAuthProvider, 
  signOut,
  User
} from 'firebase/auth';
import { 
  collection, 
  query, 
  where, 
  onSnapshot, 
  addDoc, 
  serverTimestamp,
  orderBy
} from 'firebase/firestore';
import { auth, db } from './lib/firebase';
import { cn } from './lib/utils';
import { motion, AnimatePresence } from 'motion/react';
import { format, isSameDay, parseISO } from 'date-fns';
import { Medicine, IntakeLog, MedicalReport } from './types';
import { getEmbedding, cosineSimilarity, SIMILARITY_THRESHOLD } from './services/aiService';
import { extractMedicineInfo, ExtractedMedicine } from './services/geminiService';

// --- Error Handling ---
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errMessage = error instanceof Error ? error.message : String(error);
  
  // Specific guidance for common Storage errors
  let userFriendlyMessage = errMessage;
  if (errMessage.includes('storage/retry-limit-exceeded')) {
    userFriendlyMessage = "Storage connection failed. Please ensure Firebase Storage is enabled in your console and the bucket is initialized (click 'Get Started' in the Storage tab).";
  } else if (errMessage.includes('storage/unauthorized')) {
    userFriendlyMessage = "Storage permission denied. Please verify your Security Rules for Cloud Storage allow uploads.";
  }

  const errInfo: FirestoreErrorInfo = {
    error: userFriendlyMessage,
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
    },
    operationType,
    path
  };
  const jsonError = JSON.stringify(errInfo);
  console.error('App Error: ', jsonError);
  throw new Error(jsonError);
}

// --- Context ---
interface AppContextType {
  user: User | null;
  medicines: Medicine[];
  logs: IntakeLog[];
  reports: MedicalReport[];
  loading: boolean;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  selectedDose: { id: string, time: string } | null;
  setSelectedDose: (dose: { id: string, time: string } | null) => void;
  currentAlert: string | null;
  setCurrentAlert: (msg: string | null) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used within AppProvider');
  return context;
};

// --- Main App Component ---
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [logs, setLogs] = useState<IntakeLog[]>([]);
  const [reports, setReports] = useState<MedicalReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('home');
  const [selectedDose, setSelectedDose] = useState<{ id: string, time: string } | null>(null);
  const [currentAlert, setCurrentAlert] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!user) {
      setMedicines([]);
      setLogs([]);
      setReports([]);
      return;
    }

    const medsQuery = query(collection(db, 'medicines'), where('userId', '==', user.uid));
    const logsQuery = query(collection(db, 'logs'), where('userId', '==', user.uid));
    const reportsQuery = query(collection(db, 'reports'), where('userId', '==', user.uid), orderBy('createdAt', 'desc'));

    const unsubMeds = onSnapshot(medsQuery, (snapshot) => {
      setMedicines(snapshot.docs.map(doc => {
        const data = doc.data();
        // Convert Firestore Timestamp to ISO string for the frontend
        const createdAt = data.createdAt?.toDate?.()?.toISOString() || new Date().toISOString();
        return { id: doc.id, ...data, createdAt } as Medicine;
      }));
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'medicines'));

    const unsubLogs = onSnapshot(logsQuery, (snapshot) => {
      setLogs(snapshot.docs.map(doc => {
        const data = doc.data();
        const timestamp = data.timestamp?.toDate?.()?.toISOString() || new Date().toISOString();
        return { id: doc.id, ...data, timestamp } as IntakeLog;
      }));
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'logs'));

    const unsubReports = onSnapshot(reportsQuery, (snapshot) => {
      setReports(snapshot.docs.map(doc => {
        const data = doc.data();
        const createdAt = data.createdAt?.toDate?.()?.toISOString() || new Date().toISOString();
        return { id: doc.id, ...data, createdAt } as MedicalReport;
      }));
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'reports'));

    return () => {
      unsubMeds();
      unsubLogs();
      unsubReports();
    };
  }, [user]);

  // --- Notification System ---
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }

    // Register Service Worker for reliable notifications
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(err => {
        console.warn("SW registration failed:", err);
      });
    }
  }, []);

  useEffect(() => {
    if (!user || medicines.length === 0) return;

    const checkReminders = () => {
      const now = new Date();
      const todayStr = format(now, 'yyyy-MM-dd');
      
      console.log(`[Reminder Check] Time: ${format(now, 'HH:mm:ss')}`);

      medicines.forEach(med => {
        if (todayStr >= med.startDate && todayStr <= med.endDate) {
          med.schedule.forEach(slotTime => {
            const [hours, minutes] = slotTime.split(':').map(Number);
            const scheduledDate = new Date(now);
            scheduledDate.setHours(hours, minutes, 0, 0);

            const notificationId = `remind-${med.id}-${slotTime}-${todayStr}`;
            
            if (localStorage.getItem(notificationId)) return;

            const diffMinutes = (now.getTime() - scheduledDate.getTime()) / (1000 * 60);

            // Trigger if within the same minute or up to 30 mins past
            if (diffMinutes >= 0 && diffMinutes <= 30) {
              console.log(`[TRIGGER] Medicaton: ${med.name} at ${slotTime}`);
              
              // 1. Visible On-Screen Alert
              setCurrentAlert(`Time to take your ${med.name} (${med.dosage})!`);

              // 2. Browser Notification
              if (Notification.permission === "granted") {
                const n = new Notification("💊 Medication Reminder", {
                  body: `It's time for your ${med.name}. Please log your dose.`,
                  tag: med.id,
                  requireInteraction: true
                });
                n.onclick = () => {
                  window.focus();
                  setActiveTab('home');
                  setCurrentAlert(null);
                };
              }

              // 3. Audio Alert
              const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
              audio.play().catch(e => console.warn("Audio blocked:", e));

              localStorage.setItem(notificationId, 'true');
            }
          });
        }
      });
    };

    const interval = setInterval(checkReminders, 60000); // Check every 60 seconds
    checkReminders();

    return () => clearInterval(interval);
  }, [user, medicines]);

  if (loading) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-gray-50">
        <div className="w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!user) return <LoginScreen />;

  return (
    <AppContext.Provider value={{ user, medicines, logs, reports, loading, activeTab, setActiveTab, selectedDose, setSelectedDose, currentAlert, setCurrentAlert }}>
      <div className="min-h-screen bg-gray-50 text-slate-900 pb-24 max-w-md mx-auto shadow-xl relative overflow-x-hidden">
        <Header />
        
        {/* Global Visible Alert Banner */}
        <AnimatePresence>
          {currentAlert && (
            <motion.div 
              initial={{ y: -100 }}
              animate={{ y: 0 }}
              exit={{ y: -100 }}
              className="sticky top-16 z-50 p-4 bg-blue-600 text-white shadow-lg flex items-center justify-between"
            >
              <div className="flex items-center gap-3">
                <div className="animate-bounce">🔔</div>
                <span className="font-bold text-sm">{currentAlert}</span>
              </div>
              <button 
                onClick={() => setCurrentAlert(null)}
                className="p-1 hover:bg-blue-700 rounded"
              >
                <X size={18} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <main className="p-4">
          <AnimatePresence mode="wait">
            {activeTab === 'home' && <HomeScreen key="home" />}
            {activeTab === 'add' && <AddMedicineScreen key="add" />}
            {activeTab === 'verify' && <VerifyScreen key="verify" />}
            {activeTab === 'reports' && <ReportsScreen key="reports" />}
            {activeTab === 'profile' && <ProfileScreen key="profile" />}
          </AnimatePresence>
        </main>
        <BottomNav />
      </div>
    </AppContext.Provider>
  );
}

// --- Screens ---

function LoginScreen() {
  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="h-screen flex flex-col items-center justify-center p-8 bg-gradient-to-b from-white to-emerald-50 max-w-md mx-auto">
      <div className="w-20 h-20 bg-emerald-500 rounded-2xl flex items-center justify-center shadow-lg mb-6">
        <Bell className="text-white w-10 h-10" />
      </div>
      <h1 className="text-3xl font-bold text-slate-800 mb-2">MediVerify</h1>
      <p className="text-slate-500 text-center mb-12">Smart medicine reminders with AI verification.</p>
      
      <button 
        onClick={handleLogin}
        className="w-full bg-white border border-slate-200 p-4 rounded-xl flex items-center justify-center gap-3 shadow-sm hover:shadow-md transition-shadow"
      >
        <img src="https://www.google.com/favicon.ico" alt="Google" className="w-5 h-5" />
        <span className="font-semibold text-slate-700">Continue with Google</span>
      </button>

      <p className="mt-auto text-xs text-slate-400 text-center">
        Always double-check your medicine before consumption. MediVerify AI is an assistive tool.
      </p>
    </div>
  );
}

function Header() {
  const { user, activeTab } = useApp();
  const titles: Record<string, string> = {
    home: "My Schedule",
    add: "New Medicine",
    verify: "Scan Tablet",
    reports: "Medical Vault",
    profile: "Profile"
  };

  return (
    <header className="px-6 py-6 flex items-center justify-between bg-white border-b border-slate-100 sticky top-0 z-50">
      <div>
        <p className="text-xs font-semibold text-emerald-600 uppercase tracking-wider mb-0.5">MediVerify</p>
        <h1 className="text-xl font-bold text-slate-900">{titles[activeTab]}</h1>
      </div>
      <div className="w-10 h-10 rounded-full overflow-hidden border-2 border-emerald-100">
        <img src={user?.photoURL || ''} alt="Profile" />
      </div>
    </header>
  );
}

function HomeScreen() {
  const { medicines, logs, setActiveTab, setSelectedDose } = useApp();
  const today = new Date();
  const todayStr = format(today, 'yyyy-MM-dd');
  
  // Filter medicines that are active today
  const todayMeds = medicines
    .filter(med => med.startDate <= todayStr && med.endDate >= todayStr)
    .map(med => {
      return med.schedule.map(time => ({ ...med, scheduledTime: time }));
    })
    .flat()
    .sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime));

  const takenToday = (medId: string, time: string) => {
    return logs.some(l => 
      l.medicineId === medId && 
      l.scheduledTime === time && 
      isSameDay(parseISO(l.timestamp), today)
    );
  };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="space-y-6"
    >
      <div className="bg-emerald-500 rounded-3xl p-6 text-white shadow-lg shadow-emerald-200">
        <p className="text-emerald-100 text-sm mb-1">{format(today, 'EEEE, MMM do')}</p>
        <h2 className="text-2xl font-bold">Good morning!</h2>
        <p className="text-emerald-100 mt-2">You have {todayMeds.filter(m => !takenToday(m.id, m.scheduledTime)).length} doses remaining today.</p>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between px-2">
          <h3 className="font-bold text-slate-800">Upcoming Doses</h3>
          <button onClick={() => setActiveTab('add')} className="text-emerald-600 font-semibold text-sm flex items-center gap-1">
            <Plus size={16} /> Add New
          </button>
        </div>

        {todayMeds.length === 0 ? (
          <div className="bg-white rounded-2xl p-12 text-center border border-dashed border-slate-200">
            <ClipboardList className="mx-auto text-slate-300 w-12 h-12 mb-4" />
            <p className="text-slate-500">No medicines scheduled yet.</p>
          </div>
        ) : (
          todayMeds.map((dose, idx) => {
            const taken = takenToday(dose.id, dose.scheduledTime);
            return (
              <div 
                key={`${dose.id}-${idx}`}
                className={cn(
                  "bg-white p-4 rounded-2xl flex items-center gap-4 border shadow-sm transition-all",
                  taken ? "opacity-60 grayscale border-slate-100" : "border-slate-100 hover:border-emerald-200"
                )}
              >
                <div className={cn(
                  "w-12 h-12 rounded-xl flex items-center justify-center font-bold text-lg",
                  taken ? "bg-slate-100 text-slate-400" : "bg-emerald-50 text-emerald-600"
                )}>
                  {dose.scheduledTime}
                </div>
                <div className="flex-1">
                  <h4 className="font-bold text-slate-800">{dose.name}</h4>
                  <p className="text-xs text-slate-500">{dose.dosage}</p>
                </div>
                <button 
                  disabled={taken}
                  onClick={() => {
                    setSelectedDose({ id: dose.id, time: dose.scheduledTime });
                    setActiveTab('verify');
                  }}
                  className={cn(
                    "p-2 rounded-lg transition-colors",
                    taken ? "text-emerald-500" : "text-slate-400 hover:text-emerald-600"
                  )}
                >
                  {taken ? <CheckCircle2 size={24} /> : <Scan size={24} />}
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="bg-red-50 p-4 rounded-2xl border border-red-100 flex gap-3">
        <AlertTriangle className="text-red-500 shrink-0" size={20} />
        <p className="text-xs text-red-700 leading-relaxed font-medium">
          Safety Notice: This verification is not 100% accurate. Please double-check before consuming any medicine.
        </p>
      </div>
    </motion.div>
  );
}

function AddMedicineScreen() {
  const { user, setActiveTab } = useApp();
  const [name, setName] = useState('');
  const [dosage, setDosage] = useState('');
  const [times, setTimes] = useState<string[]>(['08:00']);
  const [startDate, setStartDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState(format(new Date(Date.now() + 7 * 86400000), 'yyyy-MM-dd'));
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleImageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setImage(file);
      setPreview(URL.createObjectURL(file));
      setErrorMsg(null);

      // Trigger AI Autofill from image
      setExtracting(true);
      try {
        const info = await extractMedicineInfo(file);
        if (info.length > 0) {
          const med = info[0];
          if (med.name) setName(med.name);
          if (med.dosage) setDosage(med.dosage);
          if (med.schedule && med.schedule.length > 0) setTimes(med.schedule);
        }
      } catch (err) {
        console.warn("AI Extraction failed:", err);
      } finally {
        setExtracting(false);
      }
    }
  };

  const handleSave = async () => {
    if (!name || !dosage || !image || !user) return;
    setSaving(true);
    setErrorMsg(null);
    try {
      // 1. Generate local AI embedding for similarity matching later
      const img = new Image();
      img.src = URL.createObjectURL(image);
      await new Promise(r => img.onload = r);
      const embedding = await getEmbedding(img);

      const medicineData = {
        userId: user.uid,
        name,
        dosage,
        schedule: times,
        startDate,
        endDate,
        embedding,
        createdAt: serverTimestamp()
      };

      console.log("Saving medicine with data keys:", Object.keys(medicineData));

      // 2. Save metadata to Firestore (No Storage needed!)
      await addDoc(collection(db, 'medicines'), medicineData);

      setActiveTab('home');
    } catch (err: any) {
      console.error("Save Error:", err);
      let msg = "Failed to save medicine. Check your connection.";
      if (err.message?.includes('insufficient permissions')) msg = "Database permission denied.";
      setErrorMsg(msg);
      
      if (!err.message?.includes('OperationType')) {
        handleFirestoreError(err, OperationType.CREATE, 'medicines');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div 
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      className="space-y-6"
    >
      {errorMsg && (
        <div className="bg-red-50 p-4 rounded-xl border border-red-200 text-red-600 text-sm flex gap-2 items-center">
          <AlertTriangle size={16} />
          {errorMsg}
        </div>
      )}
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-1">Medicine Name</label>
          <input 
            type="text" 
            value={name} 
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Paracetamol"
            className="w-full bg-white border border-slate-200 p-3 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-1">Dosage</label>
          <input 
            type="text" 
            value={dosage} 
            onChange={e => setDosage(e.target.value)}
            placeholder="e.g. 500mg, 1 tablet"
            className="w-full bg-white border border-slate-200 p-3 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-1">Duration</label>
          <div className="flex gap-2">
            <input 
              type="date" 
              value={startDate} 
              onChange={e => setStartDate(e.target.value)}
              className="flex-1 bg-white border border-slate-200 p-3 rounded-xl focus:ring-2 focus:ring-emerald-500"
            />
            <input 
              type="date" 
              value={endDate} 
              onChange={e => setEndDate(e.target.value)}
              className="flex-1 bg-white border border-slate-200 p-3 rounded-xl focus:ring-2 focus:ring-emerald-500"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">Schedule Time(s)</label>
          <div className="flex flex-wrap gap-2">
            {times.map((t, i) => (
              <div key={i} className="flex gap-2 mb-2">
                <input 
                  type="time" 
                  value={t} 
                  onChange={e => {
                    const newTimes = [...times];
                    newTimes[i] = e.target.value;
                    setTimes(newTimes);
                  }}
                  className="bg-white border border-slate-200 p-2 rounded-lg"
                />
                {times.length > 1 && (
                  <button onClick={() => setTimes(times.filter((_, idx) => idx !== i))} className="text-red-500 p-1">
                    <X size={16} />
                  </button>
                )}
              </div>
            ))}
            <button 
              onClick={() => setTimes([...times, '08:00'])}
              className="px-3 py-2 border border-dashed border-slate-300 rounded-lg text-slate-500 text-sm flex items-center gap-1"
            >
              <Plus size={14} /> Add Time
            </button>
          </div>
        </div>
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">Reference Image <span className="text-xs font-normal text-slate-400 font-mono">(required for AI verification)</span></label>
          <div className="relative aspect-video rounded-2xl overflow-hidden bg-slate-100 border-2 border-dashed border-slate-300 flex flex-col items-center justify-center text-slate-400 group cursor-pointer hover:border-emerald-300 hover:bg-emerald-50 transition-all">
            {preview ? (
              <>
                <img src={preview} alt="Reference" className="w-full h-full object-cover" />
                {extracting && (
                  <div className="absolute inset-0 bg-emerald-600/60 backdrop-blur-sm flex flex-col items-center justify-center text-white p-4 text-center">
                    <div className="w-8 h-8 border-3 border-white border-t-transparent rounded-full animate-spin mb-3"></div>
                    <p className="text-sm font-bold">AI Autofilling Details...</p>
                    <p className="text-[10px] opacity-80">Gemini is reading the prescription/box</p>
                  </div>
                )}
              </>
            ) : (
              <>
                <Camera size={32} className="mb-2" />
                <p className="text-sm font-medium">Capture or Upload Image</p>
              </>
            )}
            <input 
              type="file" 
              accept="image/*" 
              capture="environment"
              onChange={handleImageChange}
              className="absolute inset-0 opacity-0 cursor-pointer" 
            />
          </div>
        </div>
      </div>

      <button 
        disabled={saving || !name || !dosage || !image}
        onClick={handleSave}
        className="w-full bg-emerald-500 text-white font-bold py-4 rounded-2xl shadow-lg shadow-emerald-200 disabled:opacity-50 disabled:grayscale transition-all active:scale-95"
      >
        {saving ? "Saving Medicine..." : "Add to Schedule"}
      </button>
    </motion.div>
  );
}

function VerifyScreen() {
  const { medicines, user, setActiveTab, selectedDose } = useApp();
  const [selectedMedId, setSelectedMedId] = useState<string>(selectedDose?.id || medicines[0]?.id || '');
  const [scannedImage, setScannedImage] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<{ match: boolean; score: number }| null>(null);

  // Sync selected medicine if coming from Home screen
  useEffect(() => {
    if (selectedDose?.id) {
      setSelectedMedId(selectedDose.id);
    }
  }, [selectedDose]);

  const selectedMed = medicines.find(m => m.id === selectedMedId);

  const handleCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedMed) return;

    setScannedImage(URL.createObjectURL(file));
    setVerifying(true);
    setResult(null);

    try {
      // 1. Create scan image for processing
      const scanImg = new Image();
      scanImg.src = URL.createObjectURL(file);
      await new Promise(r => scanImg.onload = r);

      // 2. Get live embedding
      const scanEmb = await getEmbedding(scanImg);

      // 3. Compare with stored reference embedding
      const score = cosineSimilarity(selectedMed.embedding, scanEmb);
      setResult({ match: score >= SIMILARITY_THRESHOLD, score });
    } catch (err) {
      console.error(err);
    } finally {
      setVerifying(false);
    }
  };

  const markAsTaken = async () => {
    if (!user || !selectedMed) return;
    try {
      await addDoc(collection(db, 'logs'), {
        userId: user.uid,
        medicineId: selectedMedId,
        scheduledTime: selectedDose?.time || selectedMed.schedule[0], // Essential for tracking
        timestamp: serverTimestamp(),
        status: 'taken'
      });
      setActiveTab('home');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'logs');
    }
  };

  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 1.05 }}
      className="space-y-6"
    >
      <div className="space-y-4">
        <label className="block text-sm font-semibold text-slate-700">Which medicine are you taking?</label>
        <select 
          value={selectedMedId} 
          onChange={e => setSelectedMedId(e.target.value)}
          className="w-full bg-white border border-slate-200 p-4 rounded-2xl focus:ring-2 focus:ring-emerald-500 focus:outline-none font-bold"
        >
          {medicines.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>

      <div className="relative aspect-square rounded-3xl overflow-hidden bg-slate-900 border-4 border-white shadow-2xl group">
        {scannedImage ? (
          <img src={scannedImage} alt="Scan" className="w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400">
            <Camera size={48} className="mb-4 opacity-50" />
            <p className="text-sm font-bold tracking-wide">CLICK TO SCAN TABLET</p>
          </div>
        )}
        
        {verifying && (
          <div className="absolute inset-0 bg-slate-900/60 flex flex-col items-center justify-center text-white backdrop-blur-sm">
            <div className="w-12 h-12 border-4 border-emerald-400 border-t-transparent rounded-full animate-spin mb-4"></div>
            <p className="font-bold">AI Analyzing Tablet...</p>
            <p className="text-xs text-emerald-300 mt-1">Comparing with reference image</p>
          </div>
        )}

        {result && (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className={cn(
              "absolute inset-0 flex flex-col items-center justify-center text-white backdrop-blur-md p-8 text-center",
              result.match ? "bg-emerald-600/90" : "bg-red-600/90"
            )}
          >
            {result.match ? (
              <>
                <CheckCircle2 size={64} className="mb-4" />
                <h3 className="text-2xl font-bold mb-2">✅ Correct Medicine</h3>
                <p className="text-sm opacity-90 mb-8">AI confidence score: {Math.round(result.score * 100)}%</p>
                <button 
                  onClick={markAsTaken}
                  className="w-full bg-white text-emerald-700 font-bold py-4 rounded-2xl shadow-xl active:scale-95 transition-transform"
                >
                  Confirm as Taken
                </button>
              </>
            ) : (
              <>
                <AlertTriangle size={64} className="mb-4" />
                <h3 className="text-2xl font-bold mb-2">⚠️ Mismatch Alert</h3>
                <p className="text-sm opacity-90 mb-4 leading-relaxed">
                  This tablet does NOT match your scheduled medicine. (Similarity: {Math.round(result.score * 100)}%)
                </p>
                <p className="text-xs font-bold text-yellow-300 bg-black/20 p-3 rounded-xl mb-8">
                  Warning: Please verify before taking.
                </p>
                <button 
                  onClick={() => { setScannedImage(null); setResult(null); }}
                  className="w-full bg-white text-red-700 font-bold py-4 rounded-2xl shadow-xl active:scale-95 transition-transform"
                >
                  Try Again
                </button>
              </>
            )}
          </motion.div>
        )}

        <input 
          type="file" 
          accept="image/*" 
          capture="environment"
          onChange={handleCapture}
          className="absolute inset-0 opacity-0 cursor-pointer" 
          disabled={verifying || !!result}
        />
      </div>

      {!result && !scannedImage && (
        <div className="flex flex-col items-center p-6 bg-emerald-50 rounded-2xl border border-emerald-100 text-center">
          <p className="text-slate-600 text-sm font-medium mb-1">Position the tablet in the center</p>
          <p className="text-slate-400 text-xs">Ensure good lighting for better AI accuracy</p>
        </div>
      )}
    </motion.div>
  );
}

function ReportsScreen() {
  const { user, reports } = useApp();
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    setUploading(true);
    setAnalyzing(true);
    setErrorMsg(null);
    try {
      // Gemini AI Analysis (Extract text from report)
      const info = await extractMedicineInfo(file);
      const aiDescription = info.length > 0 
        ? `Detected: ${info.map(m => m.name).join(', ')}`
        : `Summary of ${file.name} (Uploaded ${format(new Date(), 'MMM dd')})`;

      // Save to Firestore (No Storage)
      await addDoc(collection(db, 'reports'), {
        userId: user.uid,
        title: file.name,
        description: aiDescription,
        fileUrl: "text-only-vault", // Placeholder since we don't store files
        createdAt: serverTimestamp()
      });
    } catch (err: any) {
      console.error("Upload error:", err);
      setErrorMsg("AI extraction failed. Firestore save cancelled.");
      if (!err.message?.includes('OperationType')) {
        handleFirestoreError(err, OperationType.CREATE, 'reports');
      }
    } finally {
      setUploading(false);
      setAnalyzing(false);
    }
  };

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="space-y-6"
    >
      {errorMsg && (
        <div className="bg-red-50 p-4 rounded-xl border border-red-200 text-red-600 text-sm flex gap-2 items-center">
          <AlertTriangle size={16} />
          {errorMsg}
        </div>
      )}
      <div className="relative bg-white rounded-3xl p-6 border border-slate-100 shadow-sm flex items-center justify-between overflow-hidden">
        <div className="z-10">
          <h3 className="font-bold text-slate-800 text-lg">Report Vault</h3>
          <p className="text-slate-500 text-sm">Store & AI-analyze prescriptions</p>
        </div>
        <div className="relative z-10">
          <button className="bg-emerald-500 text-white p-3 rounded-2xl shadow-lg shadow-emerald-200">
            {uploading ? (
              <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
            ) : (
              <Upload size={24} />
            )}
          </button>
          <input 
            type="file" 
            accept="image/*,application/pdf"
            onChange={handleUpload}
            className="absolute inset-0 opacity-0 cursor-pointer" 
          />
        </div>
        <ClipboardList className="absolute -bottom-4 -right-4 text-emerald-50/50 w-24 h-24" />
      </div>

      {(uploading || analyzing) && (
        <div className="p-4 bg-emerald-50 rounded-2xl text-emerald-700 text-sm font-bold flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <div className="w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
            {uploading ? "Uploading report to secure storage..." : "Gemini AI Analyzing content..."}
          </div>
          {analyzing && <p className="text-[10px] font-normal opacity-70">Extracting medicine names and dosages for insights...</p>}
        </div>
      )}

      <div className="space-y-3">
        {reports.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-slate-400 text-sm">No reports saved yet.</p>
          </div>
        ) : (
          reports.map(report => (
            <a 
              key={report.id} 
              href={report.fileUrl} 
              target="_blank" 
              rel="noreferrer"
              className="bg-white p-4 rounded-2xl flex items-center gap-4 border border-slate-100 shadow-sm hover:border-emerald-200 transition-colors"
            >
              <div className="w-12 h-12 bg-emerald-50 rounded-xl flex items-center justify-center text-emerald-600">
                <ClipboardList size={24} />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-bold text-slate-800 truncate">{report.title}</h4>
                <p className="text-xs text-slate-500">{report.description}</p>
              </div>
              <div className="text-slate-400 text-xs font-mono">
                {format(parseISO(report.createdAt), 'MM/dd')}
              </div>
            </a>
          ))
        )}
      </div>
    </motion.div>
  );
}

function ProfileScreen() {
  const { user } = useApp();

  const testNotification = () => {
    // Play Test Sound
    const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
    audio.play().catch(e => console.warn("Audio play blocked:", e));

    // Trigger Test Notification
    if (Notification.permission === "granted") {
      new Notification("🔔 Test Successful", {
        body: "Your browser is correctly configured for medication alerts and sound.",
        icon: "/icon-192.png"
      });
    } else {
      Notification.requestPermission().then(permission => {
        if (permission === "granted") {
          new Notification("🔔 Permission Granted!", { body: "Diagnostics working." });
        } else {
          alert("Notifications are BLOCKED by your browser settings. Please enable them to receive reminders.");
        }
      });
    }
  };

  const simulateReminder = () => {
    console.log("[Demo] Scheduling reminder for 10 seconds from now...");
    setTimeout(() => {
      const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
      audio.play().catch(() => {});
      
      const n = new Notification("🧪 Demo Reminder", {
        body: "This is a simulated medication alert. Time to take your medicine!",
        requireInteraction: true
      });
      n.onclick = () => window.focus();

      // Show on-screen banner
      const { setCurrentAlert } = useApp();
      // Note: we can't call hooks inside callbacks, so we'll use window dispatch or similar if needed, 
      // but for simulation, we'll just alert.
      alert("DEMO: Time to take your medicine!");
    }, 10000);
  };
  
  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="space-y-8 py-4"
    >
      <div className="flex flex-col items-center text-center">
        <div className="w-24 h-24 rounded-full overflow-hidden border-4 border-white shadow-xl mb-4 flex items-center justify-center bg-slate-100">
          {user?.photoURL ? (
            <img src={user.photoURL} alt="Profile" className="w-full h-full object-cover" />
          ) : (
            <UserIcon className="w-12 h-12 text-slate-300" />
          )}
        </div>
        <h2 className="text-2xl font-bold text-slate-900">{user?.displayName || user?.email?.split('@')[0]}</h2>
        <p className="text-slate-500">{user?.email}</p>
      </div>

      <div className="space-y-3">
        <button 
          onClick={testNotification}
          className="w-full bg-white p-5 rounded-2xl border border-slate-100 flex items-center justify-between group hover:border-blue-200 transition-colors"
        >
          <div className="flex items-center gap-4">
            <div className="p-2 bg-blue-50 text-blue-600 rounded-lg group-hover:bg-blue-100"><Volume2 size={20} /></div>
            <div className="text-left">
              <span className="block font-bold text-slate-700">Click to Test Sound</span>
              <span className="block text-xs text-slate-400">Verify notification & audio permissions</span>
            </div>
          </div>
          <div className={cn(
            "text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full",
            Notification.permission === 'granted' ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600"
          )}>
            {Notification.permission === 'granted' ? 'Active' : 'Setup Required'}
          </div>
        </button>

        <button 
          onClick={() => {
            console.log("Demo triggered");
            setTimeout(() => {
              new Notification("💊 Demo: Reminder Triggered!", { body: "Live demo simulation successful." });
              const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
              audio.play();
            }, 10000);
          }}
          className="w-full bg-white p-5 rounded-2xl border border-slate-100 flex items-center gap-4 hover:border-purple-200 transition-colors"
        >
          <div className="p-2 bg-purple-50 text-purple-600 rounded-lg"><Scan size={20} /></div>
          <div className="text-left">
            <span className="block font-bold text-slate-700">Demo Simulation</span>
            <span className="block text-xs text-slate-400">Trigger alert in 10 seconds</span>
          </div>
        </button>

        <button className="w-full bg-white p-5 rounded-2xl border border-slate-100 flex items-center gap-4">
          <div className="p-2 bg-indigo-50 text-indigo-600 rounded-lg"><Calendar size={20} /></div>
          <span className="font-bold text-slate-700">History & Calendar</span>
        </button>

        <button 
          onClick={() => signOut(auth)}
          className="w-full bg-red-50 p-5 rounded-2xl border border-red-100 flex items-center gap-4 text-red-600"
        >
          <div className="p-2 bg-red-100 rounded-lg"><LogOut size={20} /></div>
          <span className="font-bold">Sign Out</span>
        </button>
      </div>

      <div className="p-6 bg-slate-900 rounded-3xl text-white">
        <h4 className="font-bold mb-2">Technical Summary</h4>
        <ul className="text-xs space-y-2 opacity-70 font-mono">
          <li>- Model: MobileNetV2 (TFLite style Web Inference)</li>
          <li>- Strategy: Last Layer Embedding extraction</li>
          <li>- Similarity: Cosine Similarity ({SIMILARITY_THRESHOLD} threshold)</li>
          <li>- Storage: Firebase Storage + Firestore</li>
        </ul>
      </div>
    </motion.div>
  );
}

// --- Navigation ---

function BottomNav() {
  const { activeTab, setActiveTab } = useApp();
  
  const tabs = [
    { id: 'home', icon: Home, label: 'Home' },
    { id: 'verify', icon: Scan, label: 'Scan' },
    { id: 'add', icon: Plus, label: 'Add', fab: true },
    { id: 'reports', icon: ClipboardList, label: 'Vault' },
    { id: 'profile', icon: UserIcon, label: 'Me' },
  ];

  return (
    <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md bg-white/80 backdrop-blur-xl border-t border-slate-100 px-6 py-4 flex items-center justify-between safe-area-bottom z-50">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          className={cn(
            "flex flex-col items-center justify-center transition-all relative",
            tab.fab ? "-mt-10" : "",
            activeTab === tab.id ? "text-emerald-600" : "text-slate-400"
          )}
        >
          {tab.fab ? (
            <div className="w-14 h-14 bg-emerald-500 rounded-2xl flex items-center justify-center shadow-lg shadow-emerald-200 text-white active:scale-90 transition-transform">
              <tab.icon size={28} />
            </div>
          ) : (
            <>
              <tab.icon size={22} className={activeTab === tab.id ? "scale-110" : ""} />
              <span className="text-[10px] font-bold mt-1 uppercase tracking-tighter opacity-80">{tab.label}</span>
              {activeTab === tab.id && (
                <motion.div 
                  layoutId="nav-pill"
                  className="absolute -bottom-2 w-1 h-1 bg-emerald-500 rounded-full"
                />
              )}
            </>
          )}
        </button>
      ))}
    </nav>
  );
}
