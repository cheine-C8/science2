// config.js — the things you change when deploying this board somewhere else.
// Plain script; must load BEFORE widgets.js and board.js (it does, from <head>).
//
// The Firebase apiKey is a public web config — that is normal for Firebase.
// Access is controlled by Firestore rules in the Firebase console, not by
// hiding the key. A hosting environment may instead inject __firebase_config /
// __app_id / __initial_auth_token globals; board.js prefers those when present.
window.WHITEBOARD_CONFIG = {
    firebase: {
        apiKey: "AIzaSyDDCSmDxGY0ltd3-KWsbbPKI_RvPQ2KIT0",
        authDomain: "whiteboard-23ad5.firebaseapp.com",
        projectId: "whiteboard-23ad5",
        storageBucket: "whiteboard-23ad5.firebasestorage.app",
        messagingSenderId: "1097713600229",
        appId: "1:1097713600229:web:b2beebee9d7a165a12360c",
    },

    // Firestore path is artifacts/{appId}/public/data/strokes/{strokeId}.
    // Change this to give a class or room its own separate board.
    appId: 'default-whiteboard',

    // Default bell schedule for the Period timer widget: [name, start, end], 24h.
    // Each device can edit its own copy inside the widget; this is just the starting point.
    bellSchedule: [
        ['Homeroom', '07:35', '07:58'], ['1st Period', '08:01', '08:47'], ['2nd Period', '08:50', '09:36'],
        ['3rd Period', '09:39', '10:25'], ['4th Period', '10:28', '11:14'], ['5th (7th Lunch)', '11:17', '12:03'],
        ['6th (8th Lunch)', '12:06', '12:52'], ['7th Period', '12:55', '13:41'], ['8th Period', '13:44', '14:30'],
    ],
};
