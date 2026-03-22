import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app-check.js";

const firebaseConfig = {
  apiKey: "AIzaSyDOI2I4oY9zvbQ7T56gRI8_xpqQEQBqMSk",
  authDomain: "rsufreedomwall-3b0db.firebaseapp.com",
  projectId: "rsufreedomwall-3b0db",
  storageBucket: "rsufreedomwall-3b0db.firebasestorage.app",
  messagingSenderId: "673274676472",
  appId: "1:673274676472:web:53fc69571f3bb547cc670d",
  measurementId: "G-4MDSWNDVEY"
};

const app = initializeApp(firebaseConfig);

const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

if (!isLocalhost) {
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider('6Lcaq6IrAAAAAJ9JR4z19HGCQVsUbZvStdoLeipj'),
    isTokenAutoRefreshEnabled: true
  });
}

export const db = initializeFirestore(app, {});