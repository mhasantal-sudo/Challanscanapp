import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type FieldValue,
  type Timestamp,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import type { AppSettings, ChallanRecord } from '../types.ts';
import { cleanChallanNo, normalizeChallanDate } from '../utils/challan.ts';
import { auth, firebaseApp } from './googleAuth.ts';

export const db = firebaseConfig.firestoreDatabaseId
  ? getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId)
  : getFirestore(firebaseApp);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: Array<{
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }>;
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const user = auth.currentUser;
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path,
    authInfo: {
      userId: user?.uid,
      email: user?.email,
      emailVerified: user?.emailVerified,
      isAnonymous: user?.isAnonymous,
      tenantId: user?.tenantId,
      providerInfo:
        user?.providerData.map((provider) => ({
          providerId: provider.providerId,
          displayName: provider.displayName,
          email: provider.email,
          photoUrl: provider.photoURL,
        })) || [],
    },
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

let connectionTested = false;

export async function testFirestoreConnection(): Promise<void> {
  if (connectionTested) return;
  connectionTested = true;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('the client is offline')
    ) {
      console.error('Please check your Firebase configuration.');
    }
    // Other errors (like permission-denied on non-existent test doc) confirm connectivity
  }
}

void testFirestoreConnection();

function clipStr(val: unknown, maxLen: number): string {
  if (val === null || val === undefined) return '';
  return String(val).trim().slice(0, maxLen);
}

function stableShortHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Firestore document IDs must match `^[a-zA-Z0-9_\-]+$` (length 1..128)
 * to satisfy security rules `isValidId(docId)`.
 */
export function toFirestoreDocId(recordId: string): string {
  const raw = String(recordId || '').trim();
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!sanitized) {
    return `rec_${stableShortHash(raw || String(Date.now()))}`;
  }
  if (sanitized.length <= 128) {
    return sanitized;
  }
  const suffix = `_${stableShortHash(raw)}`;
  return `${sanitized.slice(0, 128 - suffix.length)}${suffix}`;
}

function isShadowExtRow(r: ChallanRecord): boolean {
  return /^ch-ext-/i.test(String(r.id || '').trim());
}

function setOptStr(
  target: Record<string, unknown>,
  key: string,
  val: unknown,
  maxLen: number
) {
  const clipped = clipStr(val, maxLen);
  if (clipped) {
    target[key] = clipped;
  }
}

function buildChallanDocData(
  uid: string,
  record: ChallanRecord,
  options: {
    status?: string;
    createdAt?: Timestamp | FieldValue;
  } = {}
): Record<string, unknown> {
  const serialRaw = Number(record.serialNo);
  const serialNo =
    Number.isFinite(serialRaw) && serialRaw >= 0 && serialRaw <= 1000000
      ? serialRaw
      : 0;

  const docData: Record<string, unknown> = {
    ownerId: uid,
    recordId:
      clipStr(record.recordId || record.id || Date.now(), 200) ||
      `rec_${Date.now()}`,
    serialNo,
    challanCategory: clipStr(record.challanCategory, 120) || 'মূল চালান',
    status: options.status === 'archived' ? 'archived' : 'active',
    createdAt: options.createdAt ?? serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  setOptStr(docData, 'id', record.id, 120);
  setOptStr(docData, 'date', normalizeChallanDate(record.date), 40);
  setOptStr(docData, 'department', record.department, 200);
  setOptStr(docData, 'taxDepartment', record.taxDepartment, 200);
  setOptStr(docData, 'unionName', record.unionName, 150);
  setOptStr(docData, 'dealerName', record.dealerName, 200);
  setOptStr(docData, 'dealerId', record.dealerId, 128);
  setOptStr(docData, 'dealerAllocationId', record.dealerAllocationId, 128);
  setOptStr(docData, 'sourceMemo', record.sourceMemo, 120);
  setOptStr(docData, 'dcMemo', record.dcMemo, 120);
  setOptStr(docData, 'toOrganization', record.toOrganization, 200);
  setOptStr(docData, 'submittedThrough', record.submittedThrough, 200);
  setOptStr(docData, 'submittedOnBehalfOf', record.submittedOnBehalfOf, 200);
  setOptStr(docData, 'challanNo', record.challanNo, 32);
  setOptStr(docData, 'description', record.description, 1000);
  setOptStr(docData, 'quantity', record.quantity, 40);
  setOptStr(docData, 'rate', record.rate, 40);
  setOptStr(docData, 'amount', record.amount, 40);
  setOptStr(docData, 'challanDate', normalizeChallanDate(record.challanDate), 40);
  setOptStr(docData, 'incomeTaxChallanNo', record.incomeTaxChallanNo, 32);
  setOptStr(
    docData,
    'incomeTaxDate',
    normalizeChallanDate(record.incomeTaxDate),
    40
  );
  setOptStr(docData, 'incomeTaxAmount', record.incomeTaxAmount, 40);
  setOptStr(docData, 'vatChallanNo', record.vatChallanNo, 32);
  setOptStr(docData, 'vatDate', normalizeChallanDate(record.vatDate), 40);
  setOptStr(docData, 'vatAmount', record.vatAmount, 40);
  setOptStr(docData, 'licenseNo', record.licenseNo, 120);
  setOptStr(docData, 'expectedAmount', record.expectedAmount, 40);
  setOptStr(docData, 'expectedTaxAmount', record.expectedTaxAmount, 40);
  setOptStr(docData, 'new37Code', record.new37Code, 60);
  setOptStr(docData, 'taxCode', record.taxCode, 60);
  setOptStr(docData, 'vatCode', record.vatCode, 60);
  setOptStr(docData, 'licenseActionType', record.licenseActionType, 40);
  setOptStr(docData, 'doNo', record.doNo, 80);
  setOptStr(docData, 'doIssueDate', record.doIssueDate, 40);
  setOptStr(docData, 'comment', record.comment, 1000);
  setOptStr(docData, 'taxComment', record.taxComment, 1000);
  setOptStr(docData, 'taxExtra', record.taxExtra, 400);
  setOptStr(docData, 'pdfUrl', record.pdfUrl, 600);
  setOptStr(docData, 'entryTime', record.entryTime, 64);

  return docData;
}

function firestoreDataToChallan(
  docId: string,
  data: Record<string, unknown>
): ChallanRecord {
  const str = (key: string) =>
    typeof data[key] === 'string' ? (data[key] as string) : '';

  const serialNo =
    typeof data.serialNo === 'number' && Number.isFinite(data.serialNo)
      ? data.serialNo
      : 0;

  return {
    serialNo,
    id: str('id') || undefined,
    date: normalizeChallanDate(str('date')) || undefined,
    department: str('department') || undefined,
    taxDepartment: str('taxDepartment') || undefined,
    unionName: str('unionName'),
    dealerName: str('dealerName'),
    dealerId: str('dealerId') || undefined,
    dealerAllocationId: str('dealerAllocationId') || undefined,
    challanCategory: str('challanCategory') || 'মূল চালান',
    sourceMemo: str('sourceMemo') || undefined,
    dcMemo: str('dcMemo') || undefined,
    toOrganization: str('toOrganization'),
    submittedThrough: str('submittedThrough'),
    submittedOnBehalfOf: str('submittedOnBehalfOf'),
    challanNo: str('challanNo'),
    description: str('description'),
    quantity: str('quantity'),
    rate: str('rate'),
    amount: str('amount'),
    challanDate: normalizeChallanDate(str('challanDate')),
    incomeTaxChallanNo: str('incomeTaxChallanNo') || undefined,
    incomeTaxDate: normalizeChallanDate(str('incomeTaxDate')) || undefined,
    incomeTaxAmount: str('incomeTaxAmount') || undefined,
    vatChallanNo: str('vatChallanNo') || undefined,
    vatDate: normalizeChallanDate(str('vatDate')) || undefined,
    vatAmount: str('vatAmount') || undefined,
    licenseNo: str('licenseNo') || undefined,
    expectedAmount: str('expectedAmount') || undefined,
    expectedTaxAmount: str('expectedTaxAmount') || undefined,
    new37Code: str('new37Code') || undefined,
    taxCode: str('taxCode') || undefined,
    vatCode: str('vatCode') || undefined,
    licenseActionType: (str('licenseActionType') ||
      undefined) as ChallanRecord['licenseActionType'],
    doNo: str('doNo') || undefined,
    doIssueDate: str('doIssueDate') || undefined,
    comment: str('comment') || undefined,
    taxComment: str('taxComment') || undefined,
    taxExtra: str('taxExtra') || undefined,
    recordId: str('recordId') || docId,
    pdfUrl: str('pdfUrl'),
    entryTime: str('entryTime'),
  };
}

export async function ensureWorkspaceDoc(
  uid: string,
  settings?: AppSettings,
  recordCount?: number
): Promise<void> {
  const wsPath = `users/${uid}`;
  const wsRef = doc(db, 'users', uid);

  let existingSnap;
  try {
    existingSnap = await getDoc(wsRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, wsPath);
  }

  const officeTitle =
    clipStr(settings?.officeTitle, 200) ||
    'উপজেলা খাদ্য নিয়ন্ত্রকের কার্যালয়';

  const updateFields: Record<string, unknown> = {
    officeTitle,
    updatedAt: serverTimestamp(),
  };

  setOptStr(updateFields, 'officeSubtitle', settings?.officeSubtitle, 200);
  setOptStr(updateFields, 'spreadsheetId', settings?.spreadsheetId, 128);
  setOptStr(updateFields, 'challanTabName', settings?.challanTabName, 100);
  setOptStr(updateFields, 'gasWebAppUrl', settings?.gasWebAppUrl, 500);
  if (
    settings?.syncMethod === 'oauth' ||
    settings?.syncMethod === 'apps_script' ||
    settings?.syncMethod === 'both'
  ) {
    updateFields.syncMethod = settings.syncMethod;
  }
  if (
    typeof recordCount === 'number' &&
    Number.isFinite(recordCount) &&
    recordCount >= 0 &&
    recordCount <= 1000000
  ) {
    updateFields.recordCount = Math.floor(recordCount);
  }

  if (!existingSnap.exists()) {
    try {
      await setDoc(wsRef, {
        ownerId: uid,
        createdAt: serverTimestamp(),
        ...updateFields,
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, wsPath);
    }
  } else {
    try {
      await updateDoc(wsRef, updateFields);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, wsPath);
    }
  }
}

export async function upsertChallanToFirestore(
  uid: string,
  record: ChallanRecord,
  settings?: AppSettings
): Promise<void> {
  if (!uid || !record || !record.recordId || isShadowExtRow(record)) return;

  await ensureWorkspaceDoc(uid, settings);

  const docId = toFirestoreDocId(record.recordId);
  const path = `users/${uid}/challans/${docId}`;
  const ref = doc(db, 'users', uid, 'challans', docId);

  let existingSnap;
  try {
    existingSnap = await getDoc(ref);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }

  if (!existingSnap.exists()) {
    const payload = buildChallanDocData(uid, record);
    try {
      await setDoc(ref, payload);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  } else {
    const existingData = existingSnap.data();
    if (existingData.status === 'archived') return;
    const payload = buildChallanDocData(uid, record, {
      status:
        typeof existingData.status === 'string'
          ? existingData.status
          : 'active',
      createdAt: existingData.createdAt as Timestamp,
    });
    // Preserve immutable recordId stored on initial write
    if (typeof existingData.recordId === 'string' && existingData.recordId) {
      payload.recordId = existingData.recordId;
    }
    try {
      await setDoc(ref, payload);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
  }
}

export async function deleteChallanFromFirestore(
  uid: string,
  recordId: string
): Promise<void> {
  if (!uid || !recordId) return;
  const docId = toFirestoreDocId(recordId);
  const path = `users/${uid}/challans/${docId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'challans', docId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

function extractCleanNumbers(r: ChallanRecord): string[] {
  return [
    cleanChallanNo(r.challanNo),
    cleanChallanNo(r.incomeTaxChallanNo),
    cleanChallanNo(r.vatChallanNo),
  ].filter(Boolean);
}

export interface FirestoreSyncResult {
  cloudCount: number;
  importedFromCloud: ChallanRecord[];
  uploadedToCloud: ChallanRecord[];
  syncedRecordIds: string[];
}

export async function syncWithFirestore(
  uid: string,
  localRecords: ChallanRecord[],
  settings?: AppSettings,
  deletedIds: string[] = []
): Promise<FirestoreSyncResult> {
  const collPath = `users/${uid}/challans`;
  const primaryLocal = localRecords.filter(
    (r) => r.recordId && !isShadowExtRow(r)
  );

  await ensureWorkspaceDoc(uid, settings, primaryLocal.length);

  let snap;
  try {
    const q = query(
      collection(db, 'users', uid, 'challans'),
      where('ownerId', '==', uid)
    );
    snap = await getDocs(q);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, collPath);
  }

  const activeLocalIds = new Set(primaryLocal.map((r) => r.recordId));
  const deletedSet = new Set(deletedIds.filter(Boolean));
  const cloudDocsByDocId = new Map<string, ChallanRecord>();
  const cloudByRecordId = new Map<string, ChallanRecord>();
  const docsToDelete: Array<ReturnType<typeof doc>> = [];

  snap.forEach((docSnap) => {
    const raw = docSnap.data() as Record<string, unknown>;
    if (raw.status === 'archived') return;
    const rec = firestoreDataToChallan(docSnap.id, raw);
    const matchesDeleted =
      !activeLocalIds.has(rec.recordId) &&
      ((rec.recordId && deletedSet.has(rec.recordId)) ||
        deletedSet.has(docSnap.id) ||
        (rec.id && deletedSet.has(rec.id)));
    if (matchesDeleted) {
      docsToDelete.push(docSnap.ref);
      return;
    }
    cloudDocsByDocId.set(docSnap.id, rec);
    if (rec.recordId) {
      cloudByRecordId.set(rec.recordId, rec);
    }
  });

  const CHUNK_SIZE = 400;
  for (let i = 0; i < docsToDelete.length; i += CHUNK_SIZE) {
    const slice = docsToDelete.slice(i, i + CHUNK_SIZE);
    const delBatch = writeBatch(db);
    for (const ref of slice) {
      delBatch.delete(ref);
    }
    try {
      await delBatch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, collPath);
    }
  }

  // 1. Identify local records not yet in Firestore -> batch upload
  const toUpload: ChallanRecord[] = [];
  for (const r of primaryLocal) {
    if (deletedSet.has(r.recordId)) continue;
    const docId = toFirestoreDocId(r.recordId);
    if (!cloudDocsByDocId.has(docId) && !cloudByRecordId.has(r.recordId)) {
      toUpload.push(r);
    }
  }

  for (let i = 0; i < toUpload.length; i += CHUNK_SIZE) {
    const slice = toUpload.slice(i, i + CHUNK_SIZE);
    const batch = writeBatch(db);
    for (const r of slice) {
      const docId = toFirestoreDocId(r.recordId);
      const ref = doc(db, 'users', uid, 'challans', docId);
      batch.set(ref, buildChallanDocData(uid, r));
      cloudDocsByDocId.set(docId, r);
      cloudByRecordId.set(r.recordId, r);
    }
    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, collPath);
    }
  }

  // 2. Identify Firestore records missing from server store -> return for import
  const localIds = new Set(localRecords.map((r) => r.recordId));
  const localNumbers = new Set<string>();
  for (const r of localRecords) {
    for (const num of extractCleanNumbers(r)) {
      localNumbers.add(num);
    }
  }

  const importedFromCloud: ChallanRecord[] = [];
  for (const cloudRec of cloudDocsByDocId.values()) {
    if (!cloudRec.recordId || deletedSet.has(cloudRec.recordId)) continue;
    if (localIds.has(cloudRec.recordId)) continue;

    const nums = extractCleanNumbers(cloudRec);
    if (nums.length > 0 && nums.some((n) => localNumbers.has(n))) {
      continue;
    }
    importedFromCloud.push(cloudRec);
    for (const n of nums) localNumbers.add(n);
  }

  // Update workspace record count snapshot
  await ensureWorkspaceDoc(
    uid,
    settings,
    Math.max(
      primaryLocal.length + importedFromCloud.length,
      cloudDocsByDocId.size
    )
  );

  return {
    cloudCount: cloudDocsByDocId.size,
    importedFromCloud,
    uploadedToCloud: toUpload,
    syncedRecordIds: Array.from(cloudByRecordId.keys()),
  };
}

