# Firestore rules for the whiteboard

These go in the Firebase console: **Firestore Database → Rules** (project `whiteboard-23ad5`).
They are not deployed from this repo — paste them in and click **Publish**.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // MAIN board: anyone can view, only the main-board accounts can draw.
    // Keep this email list in sync with MAIN_BOARD_EDITORS in board.js.
    match /artifacts/{appId}/public/data/strokes/{strokeId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null
                   && request.auth.token.email_verified == true
                   && request.auth.token.email in ['christian.heine@gmail.com', 'cheine@mtps.us'];
    }

    // PERSONAL boards: each signed-in Google account can read and write only its own.
    match /artifacts/{appId}/users/{userId}/strokes/{strokeId} {
      allow read, write: if request.auth != null
                         && request.auth.uid == userId
                         && request.auth.token.email_verified == true;
    }
  }
}
```

To limit personal boards to school accounts only, add this line to the personal-board rule:
`&& request.auth.token.email.matches('.*@mtps[.]us')`
