
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const cloudinary = require("cloudinary").v2;
require("dotenv").config();

const app = express();

app.use(express.json({ limit: "10mb" }));

// =====================================
// CORS
// =====================================

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Origin not allowed"));
  }
}));

// =====================================
// FIREBASE ADMIN INITIALIZATION
// =====================================

try {
  if (!admin.apps.length) {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE64_MISSING");
    }

    const serviceAccount = JSON.parse(
      Buffer.from(
        process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
        "base64"
      ).toString("utf8")
    );

    console.log("Firebase service account loaded.");
    console.log("Firebase project:", serviceAccount.project_id);

    if (
      process.env.FIREBASE_PROJECT_ID &&
      serviceAccount.project_id !== process.env.FIREBASE_PROJECT_ID
    ) {
      throw new Error("FIREBASE_PROJECT_ID_MISMATCH");
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID ||
        serviceAccount.project_id
    });
  }

  console.log("Firebase Admin initialized successfully.");

} catch (error) {
  console.error("FIREBASE INITIALIZATION ERROR:", error.message);
  throw error;
}

const db = admin.firestore();

// =====================================
// CLOUDINARY
// =====================================

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// =====================================
// VERIFY LOGIN
// =====================================

async function verifyUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Login required"
      });
    }

    const token = header.substring(7);

    req.user = await admin.auth().verifyIdToken(token);

    next();

  } catch (error) {
    console.error("AUTH ERROR:", error.message);

    return res.status(401).json({
      success: false,
      error: "Invalid or expired login token"
    });
  }
}

// =====================================
// VERIFY ADMIN
// =====================================

async function verifyAdmin(req, res, next) {
  try {
    const userRef = db.collection("users").doc(req.user.uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(403).json({
        success: false,
        error: "Admin account document not found"
      });
    }

    const userData = userDoc.data();

    if (
      userData.role !== "admin" ||
      userData.blocked === true
    ) {
      return res.status(403).json({
        success: false,
        error: "Admin permission required"
      });
    }

    req.adminRef = userRef;
    req.adminData = userData;

    next();

  } catch (error) {
    console.error("ADMIN VERIFICATION ERROR:", error.message);

    return res.status(500).json({
      success: false,
      error: "Could not verify admin permission"
    });
  }
}

// =====================================
// HOME
// =====================================

app.get("/", (req, res) => {
  res.json({
    service: "BAZABYOSE API",
    status: "running"
  });
});

// =====================================
// HEALTH CHECK - REAL FIRESTORE TEST
// =====================================

app.get("/health", async (req, res) => {
  try {
    await db.collection("users").limit(1).get();

    res.json({
      status: "ok",
      service: "bazabyose-api",
      firebase: "connected"
    });

  } catch (error) {
    console.error("FIRESTORE CONNECTION ERROR:", {
      code: error.code || "UNKNOWN",
      message: error.message
    });

    res.status(503).json({
      status: "error",
      service: "bazabyose-api",
      firebase: "disconnected",
      errorCode: error.code || "UNKNOWN"
    });
  }
});

// =====================================
// CHECK CURRENT ADMIN
// =====================================

app.get(
  "/api/admin/me",
  verifyUser,
  verifyAdmin,
  async (req, res) => {
    res.json({
      success: true,
      isAdmin: true,
      uid: req.user.uid,
      name: req.adminData.name || "",
      email: req.adminData.email || "",
      role: req.adminData.role,
      accountType: req.adminData.accountType || "personal"
    });
  }
);

// =====================================
// ADMIN DASHBOARD STATISTICS
// =====================================

app.get(
  "/api/admin/dashboard",
  verifyUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const [users, posts, transactions] = await Promise.all([
        db.collection("users").get(),
        db.collection("Post").get(),
        db.collection("transactions").get()
      ]);

      const txList = transactions.docs.map(doc => doc.data());

      res.json({
        success: true,
        statistics: {
          totalUsers: users.size,
          totalPosts: posts.size,
          totalTransactions: transactions.size,
          pendingTransactions: txList.filter(
            tx => tx.status === "pending"
          ).length,
          approvedTransactions: txList.filter(
            tx => tx.status === "approved"
          ).length,
          rejectedTransactions: txList.filter(
            tx => tx.status === "rejected"
          ).length
        }
      });

    } catch (error) {
      console.error("DASHBOARD ERROR:", error.message);

      res.status(500).json({
        success: false,
        error: "Could not load dashboard"
      });
    }
  }
);

// =====================================
// GET USERS
// =====================================

app.get(
  "/api/admin/users",
  verifyUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const snapshot = await db.collection("users")
        .limit(200)
        .get();

      const users = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      res.json({
        success: true,
        users
      });

    } catch (error) {
      console.error("USERS ERROR:", error.message);

      res.status(500).json({
        success: false,
        error: "Could not load users"
      });
    }
  }
);

// =====================================
// GET POSTS
// =====================================

app.get(
  "/api/admin/posts",
  verifyUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const snapshot = await db.collection("Post")
        .limit(200)
        .get();

      const posts = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      res.json({
        success: true,
        posts
      });

    } catch (error) {
      console.error("POSTS ERROR:", error.message);

      res.status(500).json({
        success: false,
        error: "Could not load posts"
      });
    }
  }
);

// =====================================
// GET TRANSACTIONS
// =====================================

app.get(
  "/api/admin/transactions",
  verifyUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const snapshot = await db.collection("transactions")
        .limit(200)
        .get();

      const transactions = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      res.json({
        success: true,
        transactions
      });

    } catch (error) {
      console.error("TRANSACTIONS ERROR:", error.message);

      res.status(500).json({
        success: false,
        error: "Could not load transactions"
      });
    }
  }
);

// =====================================
// CHANGE USER BLOCK STATUS
// =====================================

app.post(
  "/api/admin/users/status",
  verifyUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const { userId, blocked } = req.body;

      if (!userId || typeof blocked !== "boolean") {
        return res.status(400).json({
          success: false,
          error: "Invalid user status"
        });
      }

      if (userId === req.user.uid && blocked === true) {
        return res.status(400).json({
          success: false,
          error: "You cannot block your own account"
        });
      }

      await db.collection("users").doc(userId).update({
        blocked,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      res.json({
        success: true
      });

    } catch (error) {
      console.error("USER STATUS ERROR:", error.message);

      res.status(500).json({
        success: false,
        error: "Could not update user status"
      });
    }
  }
);

// =====================================
// CHANGE USER ROLE
// =====================================

app.post(
  "/api/admin/users/role",
  verifyUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const { userId, role } = req.body;

      if (!userId || !["user", "admin"].includes(role)) {
        return res.status(400).json({
          success: false,
          error: "Invalid user role"
        });
      }

      if (userId === req.user.uid) {
        return res.status(400).json({
          success: false,
          error: "You cannot change your own role"
        });
      }

      await db.collection("users").doc(userId).update({
        role,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      res.json({
        success: true
      });

    } catch (error) {
      console.error("USER ROLE ERROR:", error.message);

      res.status(500).json({
        success: false,
        error: "Could not update user role"
      });
    }
  }
);

// =====================================
// CLOUDINARY SIGNED UPLOAD
// =====================================

app.post(
  "/api/media/sign",
  verifyUser,
  async (req, res) => {
    try {
      if (
        !process.env.CLOUDINARY_CLOUD_NAME ||
        !process.env.CLOUDINARY_API_KEY ||
        !process.env.CLOUDINARY_API_SECRET
      ) {
        return res.status(503).json({
          success: false,
          error: "Cloudinary is not configured"
        });
      }

      const timestamp = Math.round(Date.now() / 1000);

      const params = {
        timestamp,
        folder: "bazabyose/public"
      };

      const signature = cloudinary.utils.api_sign_request(
        params,
        process.env.CLOUDINARY_API_SECRET
      );

      res.json({
        success: true,
        cloudName: process.env.CLOUDINARY_CLOUD_NAME,
        apiKey: process.env.CLOUDINARY_API_KEY,
        timestamp,
        folder: params.folder,
        signature
      });

    } catch (error) {
      console.error("CLOUDINARY ERROR:", error.message);

      res.status(500).json({
        success: false,
        error: "Could not create upload signature"
      });
    }
  }
);

// =====================================
// UNKNOWN ROUTE
// =====================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "API route not found"
  });
});

// =====================================
// ERROR HANDLER
// =====================================

app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error.message);

  if (error.message === "Origin not allowed") {
    return res.status(403).json({
      success: false,
      error: "Origin not allowed"
    });
  }

  res.status(500).json({
    success: false,
    error: "Server error"
  });
});

// =====================================
// START SERVER
// =====================================

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BAZABYOSE API running on port ${PORT}`);
});
