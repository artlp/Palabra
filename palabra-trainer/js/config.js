/**
 * Единственный файл, который нужно заполнить перед публичным запуском.
 * Firebase web config не является паролем: доступ к данным ограничивают firestore.rules.
 */
export const APP_CONFIG = Object.freeze({
  appName: 'Palabra',
  defaultSheetUrl: '',
  defaultSheetName: '',
  sheetsAdminUid: 'uuDh6U8naZeC7hHv7U3Qex3sAtE2',
  sheetsAdminName: 'Arthur L',
  firebase: {
    apiKey: 'AIzaSyBAqf1uiIkCn2LsnigdCP3tT6VUc3ibHAk',
    authDomain: 'palabra-dbe97.firebaseapp.com',
    projectId: 'palabra-dbe97',
    storageBucket: 'palabra-dbe97.firebasestorage.app',
    messagingSenderId: '163785696617',
    appId: '1:163785696617:web:3c91b73016f6dd200289f8',
  },
});

export function isFirebaseConfigured(config = APP_CONFIG.firebase) {
  const required = ['apiKey', 'authDomain', 'projectId', 'appId'];
  return required.every((key) => {
    const value = String(config?.[key] || '');
    return value && !value.includes('PASTE_');
  });
}
