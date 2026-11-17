import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  type User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app =
  getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/spreadsheets');
provider.setCustomParameters({ prompt: 'select_account' });

let isSigningIn = false;
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

export async function googleSignIn(): Promise<{
  user: User;
  accessToken: string;
} | null> {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Google Sheets অ্যাক্সেস টোকেন পাওয়া যায়নি।');
    }
    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
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
