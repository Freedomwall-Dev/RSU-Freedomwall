import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";

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

// 🟢 CHANGED: Removed persistence setting. 
// This prevents the database from getting "locked" by multiple tabs.
export const db = initializeFirestore(app, {});