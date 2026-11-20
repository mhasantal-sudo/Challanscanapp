import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  type User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

export const firebaseApp =
  getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);

const sheetsProvider = new GoogleAuthProvider();
sheetsProvider.addScope('https://www.googleapis.com/auth/spreadsheets');
sheetsProvider.setCustomParameters({ prompt: 'select_account' });

const cloudOnlyProvider = new GoogleAuthProvider();
cloudOnlyProvider.setCustomParameters({ prompt: 'select_account' });

let isSigningIn = false;
// Store OAuth Sheets access token strictly in memory (never in localStorage/sessionStorage)
let cachedAccessToken: string | null = null;

export function initGoogleAuth(
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: (user: User | null) => void
) {
  return onAuthStateChanged(auth, (user) => {
    if (user && cachedAccessToken) {
      onAuthSuccess?.(user, cachedAccessToken);
    } else {
      if (!isSigningIn) {
        cachedAccessToken = null;
      }
      onAuthFailure?.(user);
    }
  });
}

export async function googleSignIn(options?: {
  includeSheetsScope?: boolean;
}): Promise<{
  user: User;
  accessToken: string;
} | null> {
  const includeSheets = options?.includeSheetsScope !== false;
  try {
    isSigningIn = true;
    const provider = includeSheets ? sheetsProvider : cloudOnlyProvider;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const token = credential?.accessToken || '';
    if (token) {
      cachedAccessToken = token;
    }
    return { user: result.user, accessToken: token };
  } finally {
    isSigningIn = false;
  }
}

export function getGoogleAccessToken(): string | null {
  return cachedAccessToken;
}

export function clearGoogleAccessToken(): void {
  cachedAccessToken = null;
}

export function getCurrentFirebaseUser(): User | null {
  return auth.currentUser;
}

export async function googleLogout(): Promise<void> {
  cachedAccessToken = null;
  await auth.signOut();
}


