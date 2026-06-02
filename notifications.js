const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase Admin
let firebaseApp;

function getFirebaseApp() {
  if (!firebaseApp) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
  return firebaseApp;
}

// Send notification to a single device.
// Data-only (no top-level notification field) so Android setBackgroundMessageHandler
// fires when app is killed. The mobile JS handler schedules the local notification.
async function sendNotification(fcmToken, title, body, data = {}) {
  try {
    getFirebaseApp();
    const message = {
      data: {
        ...data,
        notif_title: title,
        notif_body: body,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      android: {
        priority: 'high',
      },
      token: fcmToken,
    };

    const response = await admin.messaging().send(message);
    console.log('✅ Notification sent:', response);
    return response;
  } catch (err) {
    console.log('❌ Notification error:', err.message);
    return null;
  }
}

// Initialize Firebase at startup so getMessaging() works immediately
try { getFirebaseApp(); } catch (e) { console.log('Firebase init warning:', e.message); }

module.exports = { sendNotification };