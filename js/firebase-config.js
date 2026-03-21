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

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize App Check with reCAPTCHA v3
// Ensures only your actual website can access Firestore —
// blocks bots and direct API abuse using your config.
initializeAppCheck(app, {
  provider: new ReCaptchaV3Provider('6Lcaq6IrAAAAAJ9JR4z19HGCQVsUbZvStdoLeipj'),
  isTokenAutoRefreshEnabled: true
});

// Removed persistence setting — prevents DB from getting
// "locked" by multiple tabs.
export const db = initializeFirestore(app, {});