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

// Send notification to a single device
async function sendNotification(fcmToken, title, body, data = {}) {
  try {
    getFirebaseApp();
    const message = {
      notification: {
        title,
        body,
      },
      data: {
        ...data,
        click_action: 'FLUTTER_NOTIFICATION_CLICK'
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'default',
          priority: 'high',
          defaultVibrateTimings: true,
        }
      },
      token: fcmToken
    };

    const response = await admin.messaging().send(message);
    console.log('✅ Notification sent:', response);
    return response;
  } catch (err) {
    console.log('❌ Notification error:', err.message);
    return null;
  }
}

module.exports = { sendNotification };