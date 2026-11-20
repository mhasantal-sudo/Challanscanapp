import type { ChallanRecord } from '../types.ts';
import { cleanChallanNo } from './challan.ts';

const VAULT_STORAGE_KEY = 'challan_portal_safety_vault_v1';

export interface LocalVaultState {
  records: ChallanRecord[];
  pendingCloudIds: string[];
  pendingSheetIds: string[];
  deletedRecordIds: string[];
  updatedAt: string;
}

function emptyVault(): LocalVaultState {
  return {
    records: [],
    pendingCloudIds: [],
    pendingSheetIds: [],
    deletedRecordIds: [],
    updatedAt: '',
  };
}

export function loadLocalVault(): LocalVaultState {
  if (typeof window === 'undefined') return emptyVault();
  try {
    const raw = window.localStorage.getItem(VAULT_STORAGE_KEY);
    if (!raw) return emptyVault();
    const parsed = JSON.parse(raw) as Partial<LocalVaultState>;
    return {
      records: Array.isArray(parsed.records) ? parsed.records : [],
      pendingCloudIds: Array.isArray(parsed.pendingCloudIds)
        ? parsed.pendingCloudIds
        : [],
      pendingSheetIds: Array.isArray(parsed.pendingSheetIds)
        ? parsed.pendingSheetIds
        : [],
      deletedRecordIds: Array.isArray(parsed.deletedRecordIds)
        ? parsed.deletedRecordIds
        : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch {
    return emptyVault();
  }
}

function writeLocalVault(state: LocalVaultState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      VAULT_STORAGE_KEY,
      JSON.stringify({
        ...state,
        deletedRecordIds: state.deletedRecordIds.slice(-2000),
        updatedAt: new Date().toISOString(),
      })
    );
  } catch {
    // Ignore storage quota or private mode restrictions
  }
}

function getRecordNumberList(r: ChallanRecord): string[] {
  return [
    cleanChallanNo(r.challanNo),
    cleanChallanNo(r.incomeTaxChallanNo),
    cleanChallanNo(r.vatChallanNo),
  ].filter(Boolean);
}

export function saveServerSnapshotToVault(serverRecords: ChallanRecord[]): void {
  if (!Array.isArray(serverRecords)) return;
  const current = loadLocalVault();
  const deletedSet = new Set(current.deletedRecordIds);
  const pendingSheetSet = new Set(current.pendingSheetIds);
  const pendingCloudSet = new Set(current.pendingCloudIds);
  const byRecordId = new Map<string, ChallanRecord>();

  if (serverRecords.length === 0 && current.records.length > 0) {
    // Only keep records when server snapshot is empty if they are pending or local safety backup
    for (const r of current.records) {
      if (r.recordId && !deletedSet.has(r.recordId)) {
        byRecordId.set(r.recordId, r);
      }
    }
  } else {
    const serverIds = new Set(
      serverRecords.map((r) => r.recordId).filter(Boolean)
    );
    for (const r of current.records) {
      if (
        r.recordId &&
        !deletedSet.has(r.recordId) &&
        (serverIds.has(r.recordId) ||
          pendingSheetSet.has(r.recordId) ||
          pendingCloudSet.has(r.recordId))
      ) {
        byRecordId.set(r.recordId, r);
      }
    }
    for (const r of serverRecords) {
      if (r.recordId && !deletedSet.has(r.recordId)) {
        byRecordId.set(r.recordId, r);
      }
    }
  }

  writeLocalVault({
    ...current,
    records: Array.from(byRecordId.values()),
  });
}

export function reconcileSheetRemovedIdsInVault(removedIds: string[]): void {
  if (!Array.isArray(removedIds) || removedIds.length === 0) return;
  const current = loadLocalVault();
  const removedSet = new Set(removedIds.filter(Boolean));
  if (removedSet.size === 0) return;

  const mergedDeleted = Array.from(
    new Set([...current.deletedRecordIds, ...removedSet])
  ).slice(-2000);

  writeLocalVault({
    ...current,
    records: current.records.filter(
      (r) =>
        !removedSet.has(r.recordId) &&
        !(r.id && removedSet.has(r.id) && (!r.recordId || r.recordId === r.id))
    ),
    pendingSheetIds: current.pendingSheetIds.filter((id) => !removedSet.has(id)),
    pendingCloudIds: current.pendingCloudIds.filter((id) => !removedSet.has(id)),
    deletedRecordIds: mergedDeleted,
  });
}

export function mergeDeletedRecordIdsIntoVault(deletedIds: string[]): void {
  if (!Array.isArray(deletedIds) || deletedIds.length === 0) return;
  const current = loadLocalVault();
  const incomingSet = new Set(deletedIds.filter(Boolean));
  if (incomingSet.size === 0) return;

  const mergedDeleted = Array.from(
    new Set([...current.deletedRecordIds, ...incomingSet])
  ).slice(-2000);

  const hasNewIds = mergedDeleted.length !== current.deletedRecordIds.length;
  const filteredRecords = current.records.filter(
    (r) => !incomingSet.has(r.recordId)
  );
  const filteredPendingSheet = current.pendingSheetIds.filter(
    (id) => !incomingSet.has(id)
  );
  const filteredPendingCloud = current.pendingCloudIds.filter(
    (id) => !incomingSet.has(id)
  );

  if (
    !hasNewIds &&
    filteredRecords.length === current.records.length &&
    filteredPendingSheet.length === current.pendingSheetIds.length &&
    filteredPendingCloud.length === current.pendingCloudIds.length
  ) {
    return;
  }

  writeLocalVault({
    ...current,
    records: filteredRecords,
    pendingSheetIds: filteredPendingSheet,
    pendingCloudIds: filteredPendingCloud,
    deletedRecordIds: mergedDeleted,
  });
}

export function recordSavedInVault(
  record: ChallanRecord,
  syncedToSheet: boolean,
  syncedToCloud = false
): void {
  if (!record || !record.recordId) return;
  const current = loadLocalVault();
  const deletedSet = new Set(current.deletedRecordIds);
  deletedSet.delete(record.recordId);

  const nextRecords = current.records.filter(
    (r) => r.recordId !== record.recordId
  );
  nextRecords.push(record);

  const pendingSheetSet = new Set(current.pendingSheetIds);
  if (syncedToSheet) {
    pendingSheetSet.delete(record.recordId);
  } else {
    pendingSheetSet.add(record.recordId);
  }

  const pendingCloudSet = new Set(current.pendingCloudIds);
  if (syncedToCloud) {
    pendingCloudSet.delete(record.recordId);
  } else {
    pendingCloudSet.add(record.recordId);
  }

  writeLocalVault({
    records: nextRecords,
    pendingCloudIds: Array.from(pendingCloudSet),
    pendingSheetIds: Array.from(pendingSheetSet),
    deletedRecordIds: Array.from(deletedSet),
    updatedAt: new Date().toISOString(),
  });
}

export function markRecordDeletedInVault(recordId: string): void {
  if (!recordId) return;
  const current = loadLocalVault();
  const deletedSet = new Set(current.deletedRecordIds);
  deletedSet.add(recordId);
  const pendingSheetSet = new Set(current.pendingSheetIds);
  pendingSheetSet.delete(recordId);
  const pendingCloudSet = new Set(current.pendingCloudIds);
  pendingCloudSet.delete(recordId);

  writeLocalVault({
    records: current.records.filter((r) => r.recordId !== recordId),
    pendingCloudIds: Array.from(pendingCloudSet),
    pendingSheetIds: Array.from(pendingSheetSet),
    deletedRecordIds: Array.from(deletedSet),
    updatedAt: new Date().toISOString(),
  });
}

export function markRecordsSheetSyncedInVault(recordIds: string[]): void {
  if (recordIds.length === 0) return;
  const current = loadLocalVault();
  const syncedSet = new Set(recordIds);
  writeLocalVault({
    ...current,
    pendingSheetIds: current.pendingSheetIds.filter((id) => !syncedSet.has(id)),
  });
}

export function markRecordsPendingSheetInVault(recordIds: string[]): void {
  if (!Array.isArray(recordIds) || recordIds.length === 0) return;
  const current = loadLocalVault();
  const deletedSet = new Set(current.deletedRecordIds);
  const pendingSet = new Set(current.pendingSheetIds);
  let changed = false;
  for (const id of recordIds) {
    if (id && !deletedSet.has(id) && !pendingSet.has(id)) {
      pendingSet.add(id);
      changed = true;
    }
  }
  if (!changed) return;
  writeLocalVault({
    ...current,
    pendingSheetIds: Array.from(pendingSet),
  });
}

export function markRecordsCloudSyncedInVault(recordIds: string[]): void {
  if (recordIds.length === 0) return;
  const current = loadLocalVault();
  const syncedSet = new Set(recordIds);
  writeLocalVault({
    ...current,
    pendingCloudIds: current.pendingCloudIds.filter((id) => !syncedSet.has(id)),
  });
}

export function getPendingSheetRecordsFromVault(
  allRecords: ChallanRecord[]
): ChallanRecord[] {
  const vault = loadLocalVault();
  if (vault.pendingSheetIds.length === 0) return [];
  const pendingSet = new Set(vault.pendingSheetIds);
  const byId = new Map<string, ChallanRecord>();
  for (const r of vault.records) {
    if (r.recordId && pendingSet.has(r.recordId)) byId.set(r.recordId, r);
  }
  for (const r of allRecords) {
    if (r.recordId && pendingSet.has(r.recordId)) byId.set(r.recordId, r);
  }
  return Array.from(byId.values());
}

export function findVaultRecordsMissingFromServer(
  serverRecords: ChallanRecord[]
): ChallanRecord[] {
  const vault = loadLocalVault();
  if (vault.records.length === 0) return [];

  const isServerEmpty = serverRecords.length === 0;
  const deletedSet = new Set(vault.deletedRecordIds);
  const pendingSet = new Set([
    ...vault.pendingSheetIds,
    ...vault.pendingCloudIds,
  ]);
  const serverIds = new Set(serverRecords.map((r) => r.recordId));
  const serverNumbers = new Set<string>();
  for (const r of serverRecords) {
    for (const num of getRecordNumberList(r)) {
      serverNumbers.add(num);
    }
  }

  const missing: ChallanRecord[] = [];
  for (const v of vault.records) {
    if (!v.recordId || deletedSet.has(v.recordId)) continue;
    if (/^ch-ext-/i.test(String(v.id || ''))) continue;
    if (serverIds.has(v.recordId)) continue;

    // If the server already has records, ONLY rehydrate records explicitly pending sync
    // so records deleted from the server/Sheet on another session are never resurrected.
    if (!isServerEmpty && !pendingSet.has(v.recordId)) continue;

    const nums = getRecordNumberList(v);
    if (nums.length > 0 && nums.some((n) => serverNumbers.has(n))) {
      continue;
    }
    missing.push(v);
    for (const n of nums) serverNumbers.add(n);
  }
  return missing;
}


