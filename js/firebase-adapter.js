const FIREBASE_VERSION = '12.17.0';
const APP_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`;
const AUTH_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-auth.js`;
const FIRESTORE_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-firestore.js`;
const MAX_PUBLIC_VOCABULARY_BYTES = 700_000;

let sdkPromise = null;

async function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = Promise.all([
      import(APP_URL),
      import(AUTH_URL),
      import(FIRESTORE_URL),
    ]).then(([app, auth, firestore]) => ({ app, auth, firestore }));
  }
  return sdkPromise;
}

function cleanUndefined(value) {
  if (Array.isArray(value)) return value.map(cleanUndefined);
  if (value && typeof value === 'object') {
    if (typeof value.toDate === 'function') return value.toDate().toISOString();
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, cleanUndefined(child)]),
    );
  }
  return value;
}

function personalSettings(settings = {}) {
  const {
    sheetUrl: _legacySheetUrl,
    sheetName: _legacySheetName,
    ...personal
  } = settings || {};
  return personal;
}

function authErrorMessage(error) {
  const code = String(error?.code || '');
  const messages = {
    'auth/invalid-credential': 'Неверный email или пароль.',
    'auth/invalid-email': 'Некорректный email.',
    'auth/email-already-in-use': 'Аккаунт с таким email уже существует.',
    'auth/weak-password': 'Пароль слишком простой.',
    'auth/popup-closed-by-user': 'Окно входа было закрыто.',
    'auth/popup-blocked': 'Браузер заблокировал окно входа.',
    'auth/unauthorized-domain': 'Этот домен не добавлен в Authorized domains проекта Firebase.',
    'auth/network-request-failed': 'Сетевая ошибка при входе.',
    'auth/too-many-requests': 'Слишком много попыток. Повторите позже.',
  };
  return messages[code] || error?.message || 'Ошибка Firebase Authentication.';
}

export async function createFirebaseClient(firebaseConfig, onAuthChange = () => {}) {
  const sdk = await loadSdk();
  const app = sdk.app.initializeApp(firebaseConfig);
  const auth = sdk.auth.getAuth(app);
  const db = sdk.firestore.getFirestore(app);
  const provider = new sdk.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  try {
    await sdk.auth.setPersistence(auth, sdk.auth.browserSessionPersistence);
  } catch (error) {
    console.warn('Firebase persistence:', error);
  }

  try {
    await sdk.auth.getRedirectResult(auth);
  } catch (error) {
    console.warn('Firebase redirect result:', authErrorMessage(error));
  }

  let resolveAuthReady;
  let initialAuthHandled = false;
  const authReady = new Promise((resolve) => { resolveAuthReady = resolve; });
  const unsubscribe = sdk.auth.onAuthStateChanged(auth, (user) => {
    const change = Promise.resolve(onAuthChange(user));
    if (!initialAuthHandled) {
      initialAuthHandled = true;
      change.finally(() => resolveAuthReady(user));
    }
  });

  async function signInGoogle() {
    try {
      return await sdk.auth.signInWithPopup(auth, provider);
    } catch (error) {
      error.friendlyMessage = authErrorMessage(error);
      throw error;
    }
  }

  async function signInGoogleRedirect() {
    try {
      await sdk.auth.signInWithRedirect(auth, provider);
    } catch (error) {
      error.friendlyMessage = authErrorMessage(error);
      throw error;
    }
  }

  async function registerEmail(email, password) {
    try {
      return await sdk.auth.createUserWithEmailAndPassword(auth, email, password);
    } catch (error) {
      error.friendlyMessage = authErrorMessage(error);
      throw error;
    }
  }

  async function signInEmail(email, password) {
    try {
      return await sdk.auth.signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      error.friendlyMessage = authErrorMessage(error);
      throw error;
    }
  }

  async function resetPassword(email) {
    try {
      return await sdk.auth.sendPasswordResetEmail(auth, email);
    } catch (error) {
      error.friendlyMessage = authErrorMessage(error);
      throw error;
    }
  }

  async function signOut() {
    return sdk.auth.signOut(auth);
  }

  async function loadUserState(uid) {
    const userRef = sdk.firestore.doc(db, 'users', uid);
    const [profileSnapshot, progressSnapshot, dailySnapshot, reviewsSnapshot] = await Promise.all([
      sdk.firestore.getDoc(userRef),
      sdk.firestore.getDocs(sdk.firestore.collection(db, 'users', uid, 'cardProgress')),
      sdk.firestore.getDocs(sdk.firestore.collection(db, 'users', uid, 'daily')),
      sdk.firestore.getDocs(
        sdk.firestore.query(
          sdk.firestore.collection(db, 'users', uid, 'reviews'),
          sdk.firestore.orderBy('reviewedAt', 'desc'),
          sdk.firestore.limit(200),
        ),
      ),
    ]);

    const profile = profileSnapshot.exists() ? cleanUndefined(profileSnapshot.data()) : {};
    const progress = Object.fromEntries(progressSnapshot.docs.map((snapshot) => [snapshot.id, cleanUndefined(snapshot.data())]));
    const daily = Object.fromEntries(dailySnapshot.docs.map((snapshot) => [snapshot.id, cleanUndefined(snapshot.data())]));
    const recentReviews = reviewsSnapshot.docs.map((snapshot) => ({ id: snapshot.id, ...cleanUndefined(snapshot.data()) }));

    return {
      version: 2,
      settings: personalSettings(profile.settings || {}),
      vocabulary: { words: [] },
      progress,
      daily,
      recentReviews,
      meta: profile.meta || {},
      profileExists: profileSnapshot.exists(),
    };
  }

  function privateProfilePayload(state) {
    return {
      settings: {
        ...personalSettings(state.settings),
        sheetUrl: sdk.firestore.deleteField(),
        sheetName: sdk.firestore.deleteField(),
      },
      vocabulary: sdk.firestore.deleteField(),
      meta: {
        ...(state.meta || {}),
        lastSavedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };
  }

  async function saveProfile(user, state) {
    const payload = {
      displayName: user.displayName || '',
      email: user.email || '',
      photoURL: user.photoURL || '',
      ...privateProfilePayload(state),
    };
    await sdk.firestore.setDoc(sdk.firestore.doc(db, 'users', user.uid), payload, { merge: true });
  }

  async function saveSettings(uid, state) {
    await sdk.firestore.setDoc(
      sdk.firestore.doc(db, 'users', uid),
      privateProfilePayload(state),
      { merge: true },
    );
  }

  async function loadSheetSettings() {
    const snapshot = await sdk.firestore.getDoc(
      sdk.firestore.doc(db, 'appSettings', 'googleSheets'),
    );
    if (!snapshot.exists()) {
      return {
        exists: false,
        sheetUrl: '',
        sheetName: '',
        updatedAt: null,
        updatedBy: '',
      };
    }

    const data = cleanUndefined(snapshot.data());
    return {
      exists: true,
      sheetUrl: String(data.sheetUrl || ''),
      sheetName: String(data.sheetName || ''),
      updatedAt: data.updatedAt || null,
      updatedBy: String(data.updatedBy || ''),
    };
  }

  async function saveSheetSettings(user, settings) {
    if (!user?.uid) throw new Error('Для изменения источника требуется вход.');
    await sdk.firestore.setDoc(
      sdk.firestore.doc(db, 'appSettings', 'googleSheets'),
      {
        sheetUrl: String(settings?.sheetUrl || '').trim(),
        sheetName: String(settings?.sheetName || '').trim(),
        updatedBy: user.uid,
        updatedAt: sdk.firestore.serverTimestamp(),
      },
      { merge: true },
    );
    return loadSheetSettings();
  }

  async function loadPublishedVocabulary() {
    const snapshot = await sdk.firestore.getDoc(
      sdk.firestore.doc(db, 'appData', 'vocabulary'),
    );
    if (!snapshot.exists()) {
      return { exists: false, words: [], publishedAt: null };
    }
    const data = cleanUndefined(snapshot.data());
    return {
      exists: true,
      words: Array.isArray(data.words) ? data.words : [],
      publishedAt: data.publishedAt || null,
    };
  }

  async function publishVocabulary(user, words) {
    if (!user?.uid) throw new Error('Для публикации словаря требуется вход.');
    const cleanWords = cleanUndefined(Array.isArray(words) ? words : []);
    const byteLength = new TextEncoder().encode(JSON.stringify(cleanWords)).length;
    if (byteLength > MAX_PUBLIC_VOCABULARY_BYTES) {
      throw new Error('Словарь слишком большой для одного документа Firestore.');
    }
    await sdk.firestore.setDoc(
      sdk.firestore.doc(db, 'appData', 'vocabulary'),
      {
        words: cleanWords,
        publishedAt: sdk.firestore.serverTimestamp(),
      },
      { merge: false },
    );
    return loadPublishedVocabulary();
  }

  async function saveReview(uid, { progress, daily, review }) {
    const batch = sdk.firestore.writeBatch(db);
    batch.set(
      sdk.firestore.doc(db, 'users', uid, 'cardProgress', progress.wordId),
      cleanUndefined(progress),
      { merge: true },
    );
    batch.set(
      sdk.firestore.doc(db, 'users', uid, 'daily', daily.date),
      cleanUndefined(daily),
      { merge: true },
    );
    batch.set(
      sdk.firestore.doc(db, 'users', uid, 'reviews', review.id),
      cleanUndefined(review),
      { merge: true },
    );
    await batch.commit();
  }

  async function commitInChunks(operations) {
    for (let start = 0; start < operations.length; start += 400) {
      const batch = sdk.firestore.writeBatch(db);
      operations.slice(start, start + 400).forEach((operation) => operation(batch));
      await batch.commit();
    }
  }


  async function deleteCardProgress(uid, wordId) {
    await sdk.firestore.deleteDoc(sdk.firestore.doc(db, 'users', uid, 'cardProgress', wordId));
  }

  async function deleteProgress(uid) {
    const paths = ['cardProgress', 'daily', 'reviews'];
    const operations = [];
    for (const path of paths) {
      const snapshot = await sdk.firestore.getDocs(sdk.firestore.collection(db, 'users', uid, path));
      snapshot.docs.forEach((documentSnapshot) => {
        operations.push((batch) => batch.delete(documentSnapshot.ref));
      });
    }
    await commitInChunks(operations);
  }

  return {
    auth,
    authReady,
    db,
    unsubscribe,
    signInGoogle,
    signInGoogleRedirect,
    registerEmail,
    signInEmail,
    resetPassword,
    signOut,
    loadUserState,
    loadSheetSettings,
    saveSheetSettings,
    loadPublishedVocabulary,
    publishVocabulary,
    saveProfile,
    saveSettings,
    saveReview,
    deleteProgress,
    deleteCardProgress,
  };
}
