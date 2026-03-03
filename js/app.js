import { db } from './firebase-config.js';
import { 
    collection, addDoc, setDoc, serverTimestamp, onSnapshot, query, 
    orderBy, limit, startAfter, where, getCountFromServer, getDocs,
    doc, getDoc, runTransaction, updateDoc, arrayUnion, arrayRemove, increment
} from "firebase/firestore";

// =============================================================================
// 1. CONFIGURATION & CONSTANTS
// =============================================================================

const RECAPTCHA_SITE_KEY = '6Lcaq6IrAAAAAJ9JR4z19HGCQVsUbZvStdoLeipj';

const COOLDOWN_MINUTES = 0;
const HOURLY_LIMIT = 7;

let userIP = null;
const IP_CACHE_KEY = 'cachedIP';
const IP_CACHE_EXPIRY_KEY = 'cachedIPExpiry';
const IP_CACHE_TTL = 30 * 60 * 1000; // FIX: 30-min TTL — avoids stale IP from dynamic IPs/VPNs

const DEVICE_ID_KEY = 'deviceId';
let currentDeviceId = null;

let currentPage = 1;
const notesPerPage = 12;
let totalNotes = 0;
let totalPages = 0;
let isLoading = false;
let lastVisible = null;

const CACHE_DURATION = 5 * 60 * 1000;
const CACHE_KEY_NOTES = 'cachedNotes';
const CACHE_KEY_TIMESTAMP = 'cacheTimestamp';

let memoryCache = {
    notes: new Map(),
    totalNotes: null,
    timestamp: null,
    listeners: new Map()
};

let isListenerActive = false;
let currentListener = null;

// FIX: Repair gate — only runs once per session, not every page load
const REPAIR_DONE_KEY = 'repairDoneSession';

// =============================================================================
// 2. DEVICE IDENTITY & SECURITY
// =============================================================================

async function generateDeviceId() {
    const storedDeviceId = localStorage.getItem(DEVICE_ID_KEY);
    if (storedDeviceId) {
        currentDeviceId = storedDeviceId;
        return storedDeviceId;
    }
    try {
        const fingerprint = {
            userAgent: navigator.userAgent,
            screenResolution: `${window.screen.width}x${window.screen.height}`,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            languages: navigator.languages.join(','),
            hardwareConcurrency: navigator.hardwareConcurrency || 'unknown',
            deviceMemory: navigator.deviceMemory || 'unknown',
            canvas: generateCanvasFingerprint()
        };
        const encoder = new TextEncoder();
        const data = encoder.encode(JSON.stringify(fingerprint));
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const deviceId = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem(DEVICE_ID_KEY, deviceId);
        currentDeviceId = deviceId;
        return deviceId;
    } catch (error) {
        console.error('Error generating device ID:', error);
        const fallbackId = 'dev-' + Math.random().toString(36).substring(2, 15);
        localStorage.setItem(DEVICE_ID_KEY, fallbackId);
        currentDeviceId = fallbackId;
        return fallbackId;
    }
}

function generateCanvasFingerprint() {
    try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.textBaseline = 'top';
        ctx.font = '14px Arial';
        ctx.fillStyle = '#f60';
        ctx.fillRect(125, 1, 62, 20);
        ctx.fillStyle = '#069';
        ctx.fillText('Fingerprint', 2, 15);
        return canvas.toDataURL();
    } catch (e) { return 'error'; }
}

// FIX: IP cache now has a 30-minute expiry to handle dynamic IPs / VPN switches
async function getUserIP() {
    if (userIP) return userIP;
    const cachedIP = localStorage.getItem(IP_CACHE_KEY);
    const cachedExpiry = localStorage.getItem(IP_CACHE_EXPIRY_KEY);
    if (cachedIP && cachedExpiry && Date.now() < parseInt(cachedExpiry)) {
        userIP = cachedIP;
        return userIP;
    }
    try {
        const response = await fetch('https://api.ipify.org?format=json');
        const data = await response.json();
        userIP = data.ip;
        localStorage.setItem(IP_CACHE_KEY, userIP);
        localStorage.setItem(IP_CACHE_EXPIRY_KEY, (Date.now() + IP_CACHE_TTL).toString());
        return userIP;
    } catch (error) {
        console.error('Error fetching IP:', error);
        userIP = 'unknown-' + Math.random().toString(36).substring(2, 15);
        localStorage.setItem(IP_CACHE_KEY, userIP);
        localStorage.setItem(IP_CACHE_EXPIRY_KEY, (Date.now() + IP_CACHE_TTL).toString());
        return userIP;
    }
}

function encodeHTML(input) {
    if (!input) return '';
    const el = document.createElement('div');
    el.innerText = input;
    return el.innerHTML;
}

// =============================================================================
// 3. NOTE INTERACTIONS (Reactions, Views, Delete)
// =============================================================================

async function toggleReaction(noteId, noteElement) {
    if (!currentDeviceId) await generateDeviceId();
    try {
        const noteRef = doc(db, 'notes', noteId);
        const reactionBtn = noteElement.querySelector('.reaction-btn');
        reactionBtn.disabled = true;
        const noteDoc = await getDoc(noteRef);
        if (!noteDoc.exists()) {
            showToast('Note not found', true);
            reactionBtn.disabled = false;
            return;
        }
        const noteData = noteDoc.data();
        const currentReactions = noteData.reactions || [];
        const hasReacted = currentReactions.includes(currentDeviceId);
        await runTransaction(db, async (transaction) => {
            const freshNoteDoc = await transaction.get(noteRef);
            if (!freshNoteDoc.exists()) throw new Error("Note does not exist!");
            const freshData = freshNoteDoc.data();
            const freshReactions = freshData.reactions || [];
            const stillHasReacted = freshReactions.includes(currentDeviceId);
            if (stillHasReacted && hasReacted) {
                transaction.update(noteRef, { reactions: arrayRemove(currentDeviceId) });
            } else if (!stillHasReacted && !hasReacted) {
                transaction.update(noteRef, { reactions: arrayUnion(currentDeviceId) });
            }
        });
        const newHasReacted = !hasReacted;
        const newCount = hasReacted ? currentReactions.length - 1 : currentReactions.length + 1;
        updateReactionUI(noteElement, noteId, newHasReacted, newCount);
    } catch (error) {
        console.error('Error toggling reaction:', error);
        showToast('Failed to update reaction', true);
    } finally {
        const reactionBtn = noteElement.querySelector('.reaction-btn');
        if (reactionBtn) reactionBtn.disabled = false;
    }
}

function updateReactionUI(noteElement, noteId, hasReacted, reactionCount) {
    const reactionBtn = noteElement.querySelector('.reaction-btn');
    const heartIcon = reactionBtn.querySelector('i');
    const countSpan = reactionBtn.querySelector('.reaction-count');
    if (!heartIcon || !countSpan) return;
    heartIcon.className = hasReacted ? 'fas fa-heart' : 'far fa-heart';
    reactionBtn.classList.toggle('reacted', hasReacted);
    countSpan.textContent = reactionCount || 0;
}

async function incrementView(noteId, viewedBy) {
    if (!currentDeviceId) return;
    if (viewedBy && viewedBy.includes(currentDeviceId)) return;
    try {
        const noteRef = doc(db, 'notes', noteId);
        await updateDoc(noteRef, {
            viewedBy: arrayUnion(currentDeviceId),
            viewCount: increment(1)
        });
    } catch (error) {
        console.warn('View count skipped:', error);
    }
}

// FIX: After deleting, reload the page so the gap is filled with the next note
window.deleteNote = async function(noteId) {
    if (!confirm('Delete this note? This cannot be undone.')) return;
    try {
        const noteRef = doc(db, 'notes', noteId);
        await updateDoc(noteRef, { isDeleted: true, deviceId: currentDeviceId });

        const el = document.querySelector(`[data-note-id="${noteId}"]`);
        if (el) {
            el.style.transition = 'all 0.3s ease';
            el.style.opacity = '0';
            el.style.transform = 'scale(0.9)';
            await new Promise(r => setTimeout(r, 300));
            el.remove();
        }

        showToast('Note deleted successfully');
        clearCache();
        stopRealtimeListener();
        await loadNotes(); // Full reload fills the gap on the current page
    } catch (error) {
        console.error('Delete failed:', error);
        showToast('You cannot delete this note.', true);
    }
}

window.toggleMenu = function(noteId) {
    const menu = document.getElementById(`menu-${noteId}`);
    const allMenus = document.querySelectorAll('.dropdown-content');
    allMenus.forEach(el => { if (el.id !== `menu-${noteId}`) el.classList.remove('show'); });
    if (menu) {
        menu.classList.toggle('show');
        const closeMenu = (e) => {
            if (!e.target.closest('.note-menu')) {
                menu.classList.remove('show');
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => document.addEventListener('click', closeMenu), 0);
    }
}

// =============================================================================
// 4. SECURITY CHECKS
// =============================================================================

async function executeRecaptcha(action = 'post_note') {
    return new Promise((resolve, reject) => {
        if (typeof grecaptcha === 'undefined') {
            reject(new Error('reCAPTCHA not loaded. Please refresh and try again.'));
            return;
        }
        grecaptcha.ready(() => {
            grecaptcha.execute(RECAPTCHA_SITE_KEY, { action }).then(resolve).catch(reject);
        });
    });
}

async function generateSecureHash(token, deviceId, timestamp) {
    const data = `${token}:${deviceId}:${timestamp}:recaptcha_verification`;
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}



async function checkBan(deviceId) {
    try {
        const banSnap = await getDoc(doc(db, "bannedDevices", deviceId));
        if (banSnap.exists()) {
            const banData = banSnap.data();
            if (banData.active) {
                if (banData.expiresAt && banData.expiresAt.toDate() < new Date()) return { banned: false };
                let durationText = "permanently";
                if (banData.expiresAt) {
                    const remainingMs = banData.expiresAt.toDate() - new Date();
                    const remainingHours = Math.ceil(remainingMs / (1000 * 60 * 60));
                    const remainingDays = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));
                    durationText = remainingDays > 1 ? `${remainingDays} days` : `${remainingHours} hours`;
                }
                return { banned: true, reason: banData.reason || "Imperial decree", duration: durationText };
            }
        }
        return { banned: false };
    } catch (err) {
        console.error("Error checking ban:", err);
        return { banned: false };
    }
}

async function canPostServerSide(deviceId) {
    try {
        const ip = await getUserIP();
        const rateLimitRef = doc(db, 'deviceRateLimits', deviceId);
        const rateLimitDoc = await getDoc(rateLimitRef);
        const currentTime = new Date();
        if (rateLimitDoc.exists()) {
            const data = rateLimitDoc.data();
            const windowStart = data.windowStart?.toDate();
            const lastPost = data.lastPostTime?.toDate();
            const postCount = data.postCount || 0;
            // FIX: Cooldown only enforced when COOLDOWN_MINUTES > 0
            if (COOLDOWN_MINUTES > 0 && lastPost && (currentTime - lastPost) < (COOLDOWN_MINUTES * 60 * 1000)) {
                const remainingSeconds = Math.ceil((COOLDOWN_MINUTES * 60 * 1000 - (currentTime - lastPost)) / 1000);
                throw new Error(`Please wait ${remainingSeconds} seconds before posting again.`);
            }
            const oneHourAgo = new Date(currentTime.getTime() - 60 * 60 * 1000);
            if (!windowStart || windowStart < oneHourAgo) {
                await setDoc(rateLimitRef, {
                    deviceId, postCount: 1, windowStart: serverTimestamp(),
                    lastPostTime: serverTimestamp(),
                    createdAt: rateLimitDoc.exists() ? data.createdAt : serverTimestamp(),
                    updatedAt: serverTimestamp(), ip
                });
                return true;
            } else {
                if (postCount >= HOURLY_LIMIT) {
                    const resetTime = new Date(windowStart.getTime() + 60 * 60 * 1000);
                    const remainingMinutes = Math.ceil((resetTime - currentTime) / (1000 * 60));
                    throw new Error(`Hourly limit reached (${HOURLY_LIMIT} posts/hour). Try again in ${remainingMinutes} minutes.`);
                }
                await updateDoc(rateLimitRef, {
                    postCount: postCount + 1, lastPostTime: serverTimestamp(), updatedAt: serverTimestamp()
                });
                return true;
            }
        } else {
            await setDoc(rateLimitRef, {
                deviceId, postCount: 1, windowStart: serverTimestamp(),
                lastPostTime: serverTimestamp(), createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(), ip
            });
            return true;
        }
    } catch (error) {
        if (error.message.includes('wait') || error.message.includes('limit')) throw error;
        console.error('Rate limit check error:', error);
        return true;
    }
}

// =============================================================================
// 5. UI HELPERS
// =============================================================================

function linkify(text) {
    if (!text) return '';
    const escapedText = text
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    const urlRegex = /(\b(https?|ftp):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])|(\bwww\.([-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|]))/ig;
    return escapedText.replace(urlRegex, function(url) {
        let href = url;
        if (!url.match(/^https?:\/\//i)) href = 'https://' + url;
        return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="note-link">${url}</a>`;
    });
}

function showToast(message, isError = false) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.querySelector('.toast-message').textContent = message;
    toast.className = isError ? 'toast error' : 'toast';
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

function initTheme() { setTheme(localStorage.getItem('theme') || 'light'); }

function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.innerHTML = theme === 'dark' 
            ? '<i class="fas fa-sun"></i> Light Mode' 
            : '<i class="fas fa-moon"></i> Dark Mode';
    }
}

function toggleTheme() {
    const newTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
    showToast(`Switched to ${newTheme} mode`);
}

function shouldShowTerms() {
    const termsAgreed = localStorage.getItem('termsAgreed');
    const lastTermsShown = localStorage.getItem('lastTermsShown');
    const today = new Date().toDateString();
    return !(termsAgreed === 'true' && lastTermsShown === today);
}

function setButtonLoading(button, isLoading) {
    const btnText = button.querySelector('.btn-text');
    const btnSpinner = button.querySelector('.btn-spinner');
    if (isLoading) {
        btnText.style.display = 'none';
        btnSpinner.style.display = 'inline-flex';
        button.disabled = true;
    } else {
        btnText.style.display = 'inline';
        btnSpinner.style.display = 'none';
        button.disabled = false;
    }
}

function getContrastColor(hexColor) {
    if (!hexColor) return '#000000';
    const r = parseInt(hexColor.substr(1, 2), 16);
    const g = parseInt(hexColor.substr(3, 2), 16);
    const b = parseInt(hexColor.substr(5, 2), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5 ? '#000000' : '#ffffff';
}

// =============================================================================
// 6. CACHE MANAGEMENT
// =============================================================================

function isCacheValid(timestamp) {
    if (!timestamp) return false;
    return (Date.now() - timestamp) < CACHE_DURATION;
}

function saveCacheToStorage() {
    try {
        const cacheData = {
            notes: Object.fromEntries(memoryCache.notes),
            totalNotes: memoryCache.totalNotes,
            timestamp: memoryCache.timestamp
        };
        localStorage.setItem(CACHE_KEY_NOTES, JSON.stringify(cacheData));
        localStorage.setItem(CACHE_KEY_TIMESTAMP, memoryCache.timestamp?.toString() || '');
    } catch (error) { console.warn('Failed to save cache:', error); }
}

function loadCacheFromStorage() {
    try {
        const timestampStr = localStorage.getItem(CACHE_KEY_TIMESTAMP);
        const timestamp = timestampStr ? parseInt(timestampStr) : null;
        if (!isCacheValid(timestamp)) { clearCache(); return false; }
        const cacheDataStr = localStorage.getItem(CACHE_KEY_NOTES);
        if (!cacheDataStr) return false;
        const cacheData = JSON.parse(cacheDataStr);
        memoryCache.notes = new Map(Object.entries(cacheData.notes || {}));
        memoryCache.totalNotes = cacheData.totalNotes;
        memoryCache.timestamp = timestamp;
        return true;
    } catch (error) {
        console.warn('Failed to load cache:', error);
        clearCache();
        return false;
    }
}

function clearCache() {
    memoryCache.notes.clear();
    memoryCache.totalNotes = null;
    memoryCache.timestamp = null;
    localStorage.removeItem(CACHE_KEY_NOTES);
    localStorage.removeItem(CACHE_KEY_TIMESTAMP);
    sessionStorage.removeItem('lastPageLoaded');
}

function updateMemoryCache(page, notesData, totalCount) {
    const serializableData = notesData.map(note => ({
        ...note,
        createdAt: note.createdAt?.toDate ? note.createdAt.toDate().getTime() : note.createdAt
    }));
    memoryCache.notes.set(page.toString(), serializableData);
    memoryCache.totalNotes = totalCount;
    memoryCache.timestamp = Date.now();
    saveCacheToStorage();
}

function getCachedData(page) {
    if (isCacheValid(memoryCache.timestamp)) {
        const cachedNotes = memoryCache.notes.get(page.toString());
        if (cachedNotes) return { notes: cachedNotes, totalNotes: memoryCache.totalNotes, fromCache: true };
    }
    if (loadCacheFromStorage() && isCacheValid(memoryCache.timestamp)) {
        const cachedNotes = memoryCache.notes.get(page.toString());
        if (cachedNotes) return { notes: cachedNotes, totalNotes: memoryCache.totalNotes, fromCache: true };
    }
    return null;
}

// =============================================================================
// 7. REAL-TIME LISTENER — ALL PAGES (FIXED)
// =============================================================================

/**
 * FIX: Real-time listener now covers ALL pages, not just page 1.
 * It listens to a large window of docs, slices to the current page,
 * and refreshes the UI whenever Firestore pushes any change.
 */
function startRealtimeListener() {
    if (isListenerActive || !currentDeviceId) return;
    try {
        const listenLimit = notesPerPage * 10; // covers up to 10 pages
        const q = query(
            collection(db, 'notes'),
            orderBy('createdAt', 'desc'),
            limit(listenLimit)
        );
        
        currentListener = onSnapshot(q, (snapshot) => {
            const allVisible = [];
            snapshot.forEach(docSnap => {
                const data = docSnap.data();
                if (data.isDeleted !== true) allVisible.push({ id: docSnap.id, ...data });
            });

            totalNotes = Math.max(allVisible.length, memoryCache.totalNotes || 0);
            totalPages = Math.ceil(totalNotes / notesPerPage);

            let pageStart = (currentPage - 1) * notesPerPage;
            let pageNotes = allVisible.slice(pageStart, pageStart + notesPerPage);

            // If current page is now empty, move back one page
            if (pageNotes.length === 0 && currentPage > 1) {
                currentPage = Math.max(1, currentPage - 1);
                sessionStorage.setItem('lastPageLoaded', currentPage.toString());
                pageStart = (currentPage - 1) * notesPerPage;
                pageNotes = allVisible.slice(pageStart, pageStart + notesPerPage);
            }

            updateMemoryCache(currentPage, pageNotes, totalNotes);
            updateNotesUI(pageNotes, false);
            createPaginationControls();
        }, (error) => {
            console.warn('Real-time listener error:', error);
            isListenerActive = false;
        });
        
        isListenerActive = true;
    } catch (error) {
        console.warn('Failed to start real-time listener:', error);
    }
}

function stopRealtimeListener() {
    if (currentListener) { currentListener(); currentListener = null; }
    isListenerActive = false;
}

function updateNotesUI(notesData, showLoading = false) {
    const notesContainer = document.getElementById('notesContainer');
    if (!notesContainer) return;
    if (showLoading) {
        notesContainer.innerHTML = `
            <div class="loading">
                <div class="spinner-container">
                    <div class="loading-spinner">
                        <div class="loader"></div>
                        <p>Loading notes...</p>
                    </div>
                </div>
            </div>`;
        return;
    }
    notesContainer.innerHTML = '';
    const visibleNotes = notesData.filter(n => n.isDeleted !== true);
    if (visibleNotes.length === 0) {
        notesContainer.innerHTML = '<div class="no-notes">No notes yet. Be the first to post!</div>';
    } else {
        visibleNotes.forEach(noteData => addNoteToContainer(noteData));
    }
}

// Optimistic insert of new note to top of page 1
function addNewNoteToUI(noteData) {
    if (noteData.isDeleted === true) return;
    const notesContainer = document.getElementById('notesContainer');
    if (!notesContainer) return;
    const existingNote = notesContainer.querySelector(`[data-note-id="${noteData.id}"]`);
    if (existingNote) return;
    const noNotesElement = notesContainer.querySelector('.no-notes');
    if (noNotesElement) noNotesElement.remove();
    const noteElement = createNoteElement(noteData);
    noteElement.style.opacity = '0';
    noteElement.style.transform = 'translateY(-30px) scale(0.95)';
    noteElement.style.transition = 'none';
    notesContainer.insertBefore(noteElement, notesContainer.firstChild);
    noteElement.offsetHeight;
    noteElement.style.transition = 'all 0.6s cubic-bezier(0.16, 1, 0.3, 1)';
    requestAnimationFrame(() => {
        noteElement.style.opacity = '1';
        noteElement.style.transform = 'translateY(0) scale(1)';
    });
    // FIX: Keep exactly notesPerPage notes on screen — push overflow off the bottom
    const allNotes = notesContainer.querySelectorAll('.note-card');
    if (allNotes.length > notesPerPage) {
        const lastNote = allNotes[allNotes.length - 1];
        lastNote.style.transition = 'all 0.3s ease-out';
        lastNote.style.opacity = '0';
        lastNote.style.transform = 'translateY(20px) scale(0.95)';
        setTimeout(() => { if (lastNote.parentNode) lastNote.remove(); }, 300);
    }
    totalNotes++;
    totalPages = Math.ceil(totalNotes / notesPerPage);
    createPaginationControls();
}

// =============================================================================
// 8. MODAL MANAGEMENT
// =============================================================================

/**
 * FIX: Terms/reCAPTCHA modal ONLY shows when user opens Post a Note.
 * Does NOT show on page load anymore.
 * After agreeing, post modal opens automatically — no extra click needed.
 */
function openPostModal() {
    if (shouldShowTerms()) {
        const termsModal = document.getElementById('termsModal');
        if (termsModal) {
            termsModal.style.display = 'flex';
            document.body.classList.add('modal-open');
        }
        return; // agreeToTerms() will open the post modal after
    }
    const postModal = document.getElementById('postModal');
    if (postModal) {
        postModal.style.display = 'flex';
        document.body.classList.add('modal-open');
    }
}

function closePostModal() {
    const postModal = document.getElementById('postModal');
    if (postModal) {
        postModal.style.display = 'none';
        document.body.classList.remove('modal-open');
    }
    const noteForm = document.getElementById('noteForm');
    if (noteForm) noteForm.reset();
    const charCount = document.getElementById('char-count');
    if (charCount) { charCount.textContent = '0'; charCount.style.color = ''; }
    const submitBtn = document.getElementById('submitBtn');
    if (submitBtn) setButtonLoading(submitBtn, false);
}

function toggleSidebar() {
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) sidebar.classList.toggle('open');
}

function agreeToTerms() {
    localStorage.setItem('termsAgreed', 'true');
    const today = new Date().toDateString();
    const dontShowAgain = document.getElementById('dontShowAgain');
    if (dontShowAgain && dontShowAgain.checked) {
        localStorage.setItem('lastTermsShown', today);
    }
    const termsModal = document.getElementById('termsModal');
    if (termsModal) {
        termsModal.style.display = 'none';
        document.body.classList.remove('modal-open');
    }
    // FIX: Automatically open post modal right after agreeing
    const postModal = document.getElementById('postModal');
    if (postModal) {
        postModal.style.display = 'flex';
        document.body.classList.add('modal-open');
    }
    showToast('Thank you for agreeing to our terms');
}

function disagreeToTerms() {
    document.body.classList.remove('modal-open');
    window.location.href = 'about.html';
}

function updateCharCount() {
    const messageInput = document.getElementById('message');
    const charCount = document.getElementById('char-count');
    if (!messageInput || !charCount) return;
    const currentLength = messageInput.value.length;
    charCount.textContent = currentLength;
    charCount.style.color = currentLength > 200 ? '#ff6b6b' : '';
}

// =============================================================================
// 9. PAGINATION
// =============================================================================

async function getTotalNotesCount() {
    try {
        const snapshot = await getCountFromServer(query(collection(db, 'notes')));
        return snapshot.data().count;
    } catch (error) {
        console.warn('Error getting notes count:', error);
        return 0;
    }
}

function createPaginationControls() {
    const notesContainer = document.getElementById('notesContainer');
    const existingPagination = document.getElementById('paginationContainer');
    if (existingPagination) existingPagination.remove();
    if (totalPages <= 1) return;

    const paginationContainer = document.createElement('div');
    paginationContainer.id = 'paginationContainer';
    paginationContainer.className = 'pagination-container';

    const pagination = document.createElement('div');
    pagination.className = 'pagination';

    const prevBtn = document.createElement('button');
    prevBtn.className = `pagination-btn ${currentPage === 1 ? 'disabled' : ''}`;
    prevBtn.innerHTML = '<i class="fas fa-chevron-left"></i> Previous';
    prevBtn.disabled = currentPage === 1;
    prevBtn.onclick = () => goToPage(currentPage - 1);

    const pageNumbers = document.createElement('div');
    pageNumbers.className = 'page-numbers';

    let startPage = Math.max(1, currentPage - 2);
    let endPage = Math.min(totalPages, currentPage + 2);
    if (endPage - startPage < 4) {
        if (startPage === 1) endPage = Math.min(totalPages, startPage + 4);
        else if (endPage === totalPages) startPage = Math.max(1, endPage - 4);
    }

    if (startPage > 1) {
        const firstBtn = document.createElement('button');
        firstBtn.className = 'pagination-btn page-number';
        firstBtn.textContent = '1';
        firstBtn.onclick = () => goToPage(1);
        pageNumbers.appendChild(firstBtn);
        if (startPage > 2) {
            const ellipsis = document.createElement('span');
            ellipsis.className = 'pagination-ellipsis';
            ellipsis.textContent = '...';
            pageNumbers.appendChild(ellipsis);
        }
    }

    for (let i = startPage; i <= endPage; i++) {
        const pageBtn = document.createElement('button');
        pageBtn.className = `pagination-btn page-number ${i === currentPage ? 'active' : ''}`;
        pageBtn.textContent = i;
        pageBtn.onclick = () => goToPage(i);
        pageNumbers.appendChild(pageBtn);
    }

    if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
            const ellipsis = document.createElement('span');
            ellipsis.className = 'pagination-ellipsis';
            ellipsis.textContent = '...';
            pageNumbers.appendChild(ellipsis);
        }
        const lastBtn = document.createElement('button');
        lastBtn.className = 'pagination-btn page-number';
        lastBtn.textContent = totalPages;
        lastBtn.onclick = () => goToPage(totalPages);
        pageNumbers.appendChild(lastBtn);
    }

    const nextBtn = document.createElement('button');
    nextBtn.className = `pagination-btn ${currentPage === totalPages ? 'disabled' : ''}`;
    nextBtn.innerHTML = 'Next <i class="fas fa-chevron-right"></i>';
    nextBtn.disabled = currentPage === totalPages;
    nextBtn.onclick = () => goToPage(currentPage + 1);

    pagination.appendChild(prevBtn);
    pagination.appendChild(pageNumbers);
    pagination.appendChild(nextBtn);

    const pageInfo = document.createElement('div');
    pageInfo.className = 'page-info';
    pageInfo.textContent = `Page ${currentPage} of ${totalPages} (${totalNotes} total notes)`;

    paginationContainer.appendChild(pagination);
    paginationContainer.appendChild(pageInfo);
    notesContainer.parentNode.insertBefore(paginationContainer, notesContainer.nextSibling);
}

async function goToPage(pageNumber) {
    if (pageNumber < 1 || pageNumber > totalPages || pageNumber === currentPage || isLoading) return;
    currentPage = pageNumber;
    sessionStorage.setItem('lastPageLoaded', pageNumber.toString());
    await loadNotes();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// =============================================================================
// 10. LOAD NOTES (gap-fill on delete)
// =============================================================================

async function loadNotes() {
    if (isLoading) return;
    isLoading = true;
    const notesContainer = document.getElementById('notesContainer');

    // Show cached UI immediately
    const cachedData = getCachedData(currentPage);
    if (cachedData) {
        const visibleCached = cachedData.notes.filter(n => n.isDeleted !== true);
        updateNotesUI(visibleCached, false);
        totalNotes = cachedData.totalNotes;
        totalPages = Math.ceil(totalNotes / notesPerPage);
        createPaginationControls();
    }
    if (!cachedData) updateNotesUI([], true);

    try {
        // Always fresh count from Firestore
        totalNotes = await getTotalNotesCount();
        totalPages = Math.ceil(totalNotes / notesPerPage);

        // FIX: If restored session page is now out of range, reset to 1
        if (currentPage > totalPages && totalPages > 0) {
            currentPage = 1;
            sessionStorage.setItem('lastPageLoaded', '1');
        }

        if (totalNotes === 0) {
            notesContainer.innerHTML = '<div class="no-notes">No notes yet. Be the first to post!</div>';
            isLoading = false;
            createPaginationControls();
            return;
        }

        const offset = (currentPage - 1) * notesPerPage;

        /**
         * FIX: Gap-fill strategy — fetch (offset + notesPerPage + 20) docs so
         * that after filtering soft-deleted notes we always have a full page.
         */
        const fetchLimit = offset + notesPerPage + 20;
        const q = query(
            collection(db, 'notes'),
            orderBy('createdAt', 'desc'),
            limit(fetchLimit)
        );

        const snapshot = await getDocs(q);
        const allVisible = [];
        snapshot.forEach(docSnap => {
            const data = docSnap.data();
            if (data.isDeleted !== true) allVisible.push({ id: docSnap.id, ...data });
        });

        let visibleNotes = allVisible.slice(offset, offset + notesPerPage);

        // If this page is empty after deletes, go back one page
        if (visibleNotes.length === 0 && currentPage > 1) {
            currentPage = Math.max(1, currentPage - 1);
            sessionStorage.setItem('lastPageLoaded', currentPage.toString());
            const newOffset = (currentPage - 1) * notesPerPage;
            visibleNotes = allVisible.slice(newOffset, newOffset + notesPerPage);
        }

        updateMemoryCache(currentPage, visibleNotes, totalNotes);
        updateNotesUI(visibleNotes, false);
        createPaginationControls();

        if (!isListenerActive) startRealtimeListener();

    } catch (error) {
        console.error('Error loading notes:', error);
        if (!cachedData) {
            notesContainer.innerHTML = `
                <div class="error">
                    <i class="fas fa-exclamation-triangle"></i>
                    <p>Error loading notes. Please check your connection.</p>
                    <button onclick="loadNotes()" class="retry-btn">Try Again</button>
                </div>`;
            showToast('Error loading notes', true);
        }
    } finally {
        isLoading = false;
    }
}

// =============================================================================
// 11. NOTE RENDERING
// =============================================================================

function createNoteElement(noteData) {
    const noteId = noteData.id;
    const note = noteData;
    const isAuthor = note.deviceId === currentDeviceId;
    setTimeout(() => incrementView(noteId, note.viewedBy), 2000);

    const noteElement = document.createElement('div');
    noteElement.className = 'note-card';
    noteElement.style.backgroundColor = note.color;
    noteElement.style.color = getContrastColor(note.color);
    noteElement.dataset.noteId = noteId;

    if (isAuthor) {
        const menuContainer = document.createElement('div');
        menuContainer.className = 'note-menu-container';
        menuContainer.innerHTML = `
            <div class="note-menu">
                <button class="menu-btn" onclick="toggleMenu('${noteId}')" aria-label="Options">
                    <i class="fas fa-ellipsis-v"></i>
                </button>
                <div id="menu-${noteId}" class="dropdown-content">
                    <button class="dropdown-item delete-btn" onclick="deleteNote('${noteId}')">
                        <i class="fas fa-trash-alt"></i> Delete
                    </button>
                </div>
            </div>`;
        noteElement.appendChild(menuContainer);
    }

    let date;
    if (note.createdAt?.toDate) date = note.createdAt.toDate();
    else if (typeof note.createdAt === 'number') date = new Date(note.createdAt);
    else date = new Date();

    const messageDiv = document.createElement('div');
    messageDiv.className = 'note-message';
    messageDiv.innerHTML = linkify(note.message).replace(/\n/g, '<br>');

    const authorDiv = document.createElement('div');
    authorDiv.className = 'note-author';
    authorDiv.textContent = `- ${note.name}`;

    const bottomDiv = document.createElement('div');
    bottomDiv.className = 'note-bottom';

    const viewDiv = document.createElement('div');
    viewDiv.className = 'view-counter';
    viewDiv.innerHTML = `<i class="fas fa-eye"></i> Seen by ${note.viewCount || 0}`;

    const reactionDiv = document.createElement('div');
    reactionDiv.className = 'note-reaction';

    const reactionBtn = document.createElement('button');
    reactionBtn.className = 'reaction-btn';

    const reactions = note.reactions || [];
    const hasReacted = reactions.includes(currentDeviceId);
    const reactionCount = reactions.length;

    if (hasReacted) reactionBtn.classList.add('reacted');

    const heartIcon = document.createElement('i');
    heartIcon.className = hasReacted ? 'fas fa-heart' : 'far fa-heart';

    const countSpan = document.createElement('span');
    countSpan.className = 'reaction-count';
    countSpan.textContent = reactionCount;

    reactionBtn.appendChild(heartIcon);
    reactionBtn.appendChild(countSpan);
    reactionBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleReaction(noteId, noteElement);
    });

    reactionDiv.appendChild(reactionBtn);
    bottomDiv.appendChild(viewDiv);
    bottomDiv.appendChild(reactionDiv);
    noteElement.appendChild(messageDiv);
    noteElement.appendChild(authorDiv);
    noteElement.appendChild(bottomDiv);

    return noteElement;
}

function addNoteToContainer(docData) {
    const noteElement = createNoteElement(docData);
    document.getElementById('notesContainer').appendChild(noteElement);
}

// =============================================================================
// 12. SUBMIT NOTE
// =============================================================================

async function submitNote(e) {
    e.preventDefault();
    const submitBtn = document.getElementById('submitBtn');
    if (submitBtn) setButtonLoading(submitBtn, true);
    try {
        const deviceId = await generateDeviceId();
        await canPostServerSide(deviceId);

        const banStatus = await checkBan(deviceId);
        if (banStatus.banned) throw new Error(`You are banned for ${banStatus.duration}. Reason: ${banStatus.reason}`);

        let message = document.getElementById('message')?.value.trim();
        let name = document.getElementById('name')?.value.trim() || 'Anonymous';

        const selectedColorElement = document.getElementById('selectedColor');
        let color;
        if (selectedColorElement && selectedColorElement.value) {
            color = selectedColorElement.value;
        } else {
            const selectedColorOption = document.querySelector('.color-option.selected');
            color = selectedColorOption ? selectedColorOption.dataset.color : '#FFEB3B';
        }

        if (!message) throw new Error('Message is required');
        if (message.length > 400) throw new Error('Message too long (max 400 chars)');

        const [ip, recaptchaToken] = await Promise.all([
            getUserIP(),
            executeRecaptcha('post_note')
        ]);

        const timestamp = Date.now();
        const verificationId = `${deviceId}-${timestamp}`;
        generateSecureHash(recaptchaToken, deviceId, timestamp).then(secureHash => {
            setDoc(doc(db, 'recaptchaVerifications', verificationId), {
                deviceId, tokenHash: secureHash, timestamp,
                createdAt: serverTimestamp(),
                expiresAt: new Date(timestamp + 5 * 60 * 1000),
                used: false, verified: true
            }).catch(e => console.warn('Verification record skipped:', e));
        });

        const noteData = {
            message, name, color, ip, deviceId,
            recaptchaVerificationId: verificationId,
            reactions: [], viewedBy: [], viewCount: 0,
            isDeleted: false, createdAt: serverTimestamp()
        };

        const docRef = await addDoc(collection(db, 'notes'), noteData);

        try {
            await updateDoc(doc(db, 'recaptchaVerifications', verificationId), {
                used: true, usedAt: serverTimestamp()
            });
        } catch (verificationError) {
            console.warn('Could not mark verification as used:', verificationError);
        }

        const noteForm = document.getElementById('noteForm');
        if (noteForm) noteForm.reset();
        closePostModal();
        showToast('Note posted successfully!');
        clearCache();

        const newNoteData = { id: docRef.id, ...noteData, createdAt: new Date() };

        if (currentPage === 1) {
            addNewNoteToUI(newNoteData);
        } else {
            showToast('Note posted! Go to page 1 to see it.', false);
        }
    } catch (error) {
        console.error('Error posting note:', error);
        showToast(error.message, true);
    } finally {
        if (submitBtn) setButtonLoading(submitBtn, false);
    }
}

// =============================================================================
// 13. DATABASE REPAIR (once per session)
// =============================================================================

async function repairDatabase() {
    // FIX: Gated by sessionStorage — only runs once per browser session
    if (sessionStorage.getItem(REPAIR_DONE_KEY)) return;
    sessionStorage.setItem(REPAIR_DONE_KEY, '1');
    try {
        const q = query(collection(db, 'notes'), limit(20));
        const snapshot = await getDocs(q);
        snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            if (data.isDeleted === undefined) {
                updateDoc(doc(db, 'notes', docSnap.id), {
                    isDeleted: false,
                    viewCount: data.viewCount || 0,
                    viewedBy: data.viewedBy || []
                });
            }
        });
    } catch (e) {
        console.warn("Repair script skipped:", e);
    }
}

// =============================================================================
// 14. DOM INITIALIZATION
// =============================================================================

document.addEventListener('DOMContentLoaded', async function() {
    await generateDeviceId();
    loadCacheFromStorage();

    const lastPage = sessionStorage.getItem('lastPageLoaded');
    if (lastPage && !isNaN(lastPage)) currentPage = parseInt(lastPage);

    initTheme();

    document.getElementById('postNoteBtn')?.addEventListener('click', openPostModal);
    document.getElementById('mobilePostBtn')?.addEventListener('click', openPostModal);
    document.querySelector('.close-btn')?.addEventListener('click', closePostModal);
    document.getElementById('noteForm')?.addEventListener('submit', submitNote);
    document.getElementById('themeToggle')?.addEventListener('click', toggleTheme);
    document.getElementById('menuToggle')?.addEventListener('click', toggleSidebar);
    document.getElementById('agreeBtn')?.addEventListener('click', agreeToTerms);
    document.getElementById('disagreeBtn')?.addEventListener('click', disagreeToTerms);
    document.getElementById('message')?.addEventListener('input', updateCharCount);

    document.querySelector('.main-content')?.addEventListener('click', function() {
        const sidebar = document.querySelector('.sidebar');
        if (sidebar && sidebar.classList.contains('open') && window.innerWidth < 768) toggleSidebar();
    });

    const colorOptions = document.querySelectorAll('.color-option');
    if (colorOptions.length) {
        colorOptions.forEach(option => {
            option.addEventListener('click', function() {
                colorOptions.forEach(opt => opt.classList.remove('selected'));
                this.classList.add('selected');
                const selectedColor = document.getElementById('selectedColor');
                if (selectedColor) selectedColor.value = this.dataset.color;
            });
        });
        if (!document.querySelector('.color-option.selected')) colorOptions[0].classList.add('selected');
    }

    window.addEventListener('click', function(event) {
        const postModal = document.getElementById('postModal');
        const termsModal = document.getElementById('termsModal');
        if (event.target === postModal) closePostModal();
        if (event.target === termsModal) {
            termsModal.style.display = 'none';
            document.body.classList.remove('modal-open');
        }
    });

    const messageTextarea = document.getElementById("message");
    if (messageTextarea) {
        function autoResize(el) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; }
        messageTextarea.addEventListener("input", function() { autoResize(this); });
        const postModalElement = document.getElementById("postModal");
        if (postModalElement) {
            const observer = new MutationObserver(function(mutations) {
                mutations.forEach(function(mutation) {
                    if (mutation.attributeName === "style") {
                        const display = window.getComputedStyle(postModalElement).display;
                        if (display !== "none") autoResize(messageTextarea);
                    }
                });
            });
            observer.observe(postModalElement, { attributes: true });
        }
    }

    repairDatabase();

    if (document.getElementById('notesContainer')) await loadNotes();

    document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
            stopRealtimeListener();
        } else {
            if (!isListenerActive) startRealtimeListener();
        }
    });

    window.addEventListener('beforeunload', function() {
        stopRealtimeListener();
        saveCacheToStorage();
    });
});

function refreshNotes() {
    clearCache();
    stopRealtimeListener();
    loadNotes();
    showToast('Refreshing notes...');
}

window.toggleTheme = toggleTheme;
window.initTheme = initTheme;
window.loadNotes = loadNotes;
window.goToPage = goToPage;