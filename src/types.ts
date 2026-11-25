export interface Medicine {
  id: string;
  userId: string;
  name: string;
  dosage: string;
  schedule: string[];
  embedding: number[];
  startDate: string;
  endDate: string;
  createdAt: string;
}

export interface IntakeLog {
  id: string;
  userId: string;
  medicineId: string;
  scheduledTime: string;
  timestamp: string;
  status: 'taken' | 'missed';
}

export interface MedicalReport {
  id: string;
  userId: string;
  title: string;
  description?: string;
  fileUrl: string;
  createdAt: string;
}
