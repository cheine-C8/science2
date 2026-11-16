# Firestore rules for the whiteboard

These go in the Firebase console: **Databases & Storage -> Firestore -> Rules**
(project `whiteboard-23ad5`). They are not deployed from this repo - paste them in and Publish.

Reads are open to any session (the app signs visitors in anonymously) so that view-only
share links (`?view=main`, `?view={uid}`) work. Writes are always owner-only.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // MAIN board: viewable by link, only the main-board accounts can draw.
    // Keep this email list in sync with MAIN_BOARD_EDITORS in board.js.
    match /artifacts/{appId}/public/data/{document=**} {
      allow read: if request.auth != null;
      allow write: if request.auth != null
        && request.auth.token.email_verified == true
        && request.auth.token.email in ['christian.heine@gmail.com', 'cheine@mtps.us'];
    }

    // PERSONAL boards: viewable by link, only the owning account can draw.
    match /artifacts/{appId}/users/{userId}/strokes/{strokeId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null
        && request.auth.uid == userId
        && request.auth.token.email_verified == true;
    }
  }
}
```
