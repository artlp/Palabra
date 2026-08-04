const FIREBASE_VERSION = '12.17.0';
const APP_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`;
const AUTH_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-auth.js`;
const FIRESTORE_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-firestore.js`;

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
    await sdk.auth.setPersistence(auth, sdk.auth.browserLocalPersistence);
  } catch (error) {
    console.warn('Firebase persistence:', error);
  }

  try {
    await sdk.auth.getRedirectResult(auth);
  } catch (error) {
    console.warn('Firebase redirect result:', authErrorMessage(error));
  }

  const unsubscribe = sdk.auth.onAuthStateChanged(auth, (user) => onAuthChange(user));

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
      settings: profile.settings || {},
      vocabulary: profile.vocabulary || { words: [] },
      progress,
      daily,
      recentReviews,
      meta: profile.meta || {},
    };
  }

  async function saveProfile(user, state) {
    const payload = cleanUndefined({
      displayName: user.displayName || '',
      email: user.email || '',
      photoURL: user.photoURL || '',
      settings: state.settings,
      vocabulary: {
        sourceUrl: state.vocabulary?.sourceUrl || '',
        sourceType: state.vocabulary?.sourceType || '',
        syncedAt: state.vocabulary?.syncedAt || null,
      },
      meta: {
        ...(state.meta || {}),
        lastSavedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    });
    await sdk.firestore.setDoc(sdk.firestore.doc(db, 'users', user.uid), payload, { merge: true });
  }

  async function saveSettings(uid, state) {
    await sdk.firestore.setDoc(
      sdk.firestore.doc(db, 'users', uid),
      cleanUndefined({
        settings: state.settings,
        vocabulary: {
          sourceUrl: state.vocabulary?.sourceUrl || '',
          sourceType: state.vocabulary?.sourceType || '',
          syncedAt: state.vocabulary?.syncedAt || null,
        },
        meta: {
          ...(state.meta || {}),
          lastSavedAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      }),
      { merge: true },
    );
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

  async function syncFullState(user, state) {
    await saveProfile(user, state);
    const operations = [];
    Object.entries(state.progress || {}).forEach(([wordId, progress]) => {
      operations.push((batch) => batch.set(
        sdk.firestore.doc(db, 'users', user.uid, 'cardProgress', wordId),
        cleanUndefined(progress),
        { merge: true },
      ));
    });
    Object.entries(state.daily || {}).forEach(([date, daily]) => {
      operations.push((batch) => batch.set(
        sdk.firestore.doc(db, 'users', user.uid, 'daily', date),
        cleanUndefined(daily),
        { merge: true },
      ));
    });
    (state.recentReviews || []).slice(0, 800).forEach((review) => {
      if (!review.id) return;
      operations.push((batch) => batch.set(
        sdk.firestore.doc(db, 'users', user.uid, 'reviews', review.id),
        cleanUndefined(review),
        { merge: true },
      ));
    });
    await commitInChunks(operations);
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
    db,
    unsubscribe,
    signInGoogle,
    signInGoogleRedirect,
    registerEmail,
    signInEmail,
    resetPassword,
    signOut,
    loadUserState,
    saveProfile,
    saveSettings,
    saveReview,
    syncFullState,
    deleteProgress,
    deleteCardProgress,
  };
}
