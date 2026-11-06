
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const cloudinary = require("cloudinary").v2;
require("dotenv").config();

const app = express();

app.use(express.json({ limit: "10mb" }));

// CORS SECURITY
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

// FIREBASE ADMIN INITIALIZATION
if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const serviceAccount = JSON.parse(
      Buffer.from(
        process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
        "base64"
      ).toString("utf8")
    );

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } else {
    admin.initializeApp({
      credential: admin.credential.applicationDefault()
    });
  }
}

const db = admin.firestore();

// CLOUDINARY CONFIGURATION
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// VERIFY LOGIN TOKEN
async function verifyUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Login required"
      });
    }

    const token = header.substring(7);
    req.user = await admin.auth().verifyIdToken(token);

    next();
  } catch (error) {
    return res.status(401).json({
      error: "Invalid or expired login token"
    });
  }
}

// VERIFY ADMIN ROLE
async function verifyAdmin(req, res, next) {
  try {
    const userRef = db.collection("users").doc(req.user.uid);
    const userDoc = await userRef.get();

    if (
      !userDoc.exists ||
      userDoc.data().role !== "admin" ||
      userDoc.data().blocked === true
    ) {
      return res.status(403).json({
        error: "Admin permission required"
      });
    }

    req.adminRef = userRef;
    req.adminData = userDoc.data();

    next();
  } catch (error) {
    return res.status(500).json({
      error: "Could not verify admin permission"
    });
  }
}

// SERVER STATUS
app.get("/", (req, res) => {
  res.json({
    service: "BAZABYOSE API",
    status: "running"
  });
});

// HEALTH CHECK
app.get("/health", async (req, res) => {
  try {
    await db.collection("users").limit(1).get();

    res.json({
      status: "ok",
      service: "bazabyose-api",
      firebase: "connected"
    });
  } catch (error) {
    res.status(503).json({
      status: "error",
      service: "bazabyose-api",
      firebase: "disconnected"
    });
  }
});

// CHECK CURRENT ADMIN
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

// ADMIN DASHBOARD STATISTICS
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
      res.status(500).json({
        error: "Could not load dashboard statistics"
      });
    }
  }
);

// GET ALL USERS
app.get(
  "/api/admin/users",
  verifyUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const snapshot = await db.collection("users").limit(200).get();

      const users = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      res.json({
        success: true,
        users
      });
    } catch (error) {
      res.status(500).json({
        error: "Could not load users"
      });
    }
  }
);

// GET ALL POSTS
app.get(
  "/api/admin/posts",
  verifyUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const snapshot = await db.collection("Post").limit(200).get();

      const posts = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      res.json({
        success: true,
        posts
      });
    } catch (error) {
      res.status(500).json({
        error: "Could not load posts"
      });
    }
  }
);

// GET ALL TRANSACTIONS
app.get(
  "/api/admin/transactions",
  verifyUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const snapshot = await db.collection("transactions").limit(200).get();

      const transactions = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      res.json({
        success: true,
        transactions
      });
    } catch (error) {
      res.status(500).json({
        error: "Could not load transactions"
      });
    }
  }
);

// CREATE CLOUDINARY SIGNATURE
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
        cloudName: process.env.CLOUDINARY_CLOUD_NAME,
        apiKey: process.env.CLOUDINARY_API_KEY,
        timestamp,
        folder: params.folder,
        signature
      });
    } catch (error) {
      res.status(500).json({
        error: "Could not create upload signature"
      });
    }
  }
);

// PROCESS ADMIN TRANSACTIONS
app.post(
  "/api/admin/transactions/process",
  verifyUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const { transactionId, action } = req.body;

      if (
        !transactionId ||
        !["approve", "reject"].includes(action)
      ) {
        return res.status(400).json({
          error: "Invalid transaction request"
        });
      }

      const txRef = db.collection("transactions").doc(transactionId);

      const result = await db.runTransaction(async transaction => {
        const txDoc = await transaction.get(txRef);

        if (!txDoc.exists) {
          throw new Error("TRANSACTION_NOT_FOUND");
        }

        const tx = txDoc.data();

        if (tx.status !== "pending") {
          throw new Error("TRANSACTION_ALREADY_PROCESSED");
        }

        const amount = Number(tx.amount);

        if (!Number.isFinite(amount) || amount <= 0) {
          throw new Error("INVALID_AMOUNT");
        }

        const userId = tx.userId || tx.uid;

        if (!userId) {
          throw new Error("USER_ID_MISSING");
        }

        const userRef = db.collection("users").doc(userId);
        const userDoc = await transaction.get(userRef);

        if (!userDoc.exists) {
          throw new Error("USER_NOT_FOUND");
        }

        const user = userDoc.data();
        const balance = Number(user.balance || 0);

        if (!Number.isFinite(balance) || balance < 0) {
          throw new Error("INVALID_USER_BALANCE");
        }

        if (action === "approve") {
          if (tx.type === "deposit") {
            transaction.update(userRef, {
              balance: balance + amount
            });
          } else if (tx.type === "cashout") {
            if (balance < amount) {
              throw new Error("INSUFFICIENT_BALANCE");
            }

            transaction.update(userRef, {
              balance: balance - amount
            });
          } else {
            throw new Error("INVALID_TRANSACTION_TYPE");
          }
        }

        transaction.update(txRef, {
          status: action === "approve" ? "approved" : "rejected",
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
          processedBy: req.user.uid
        });

        return {
          transactionId,
          status: action === "approve" ? "approved" : "rejected"
        };
      });

      res.json({
        success: true,
        result
      });

    } catch (error) {
      res.status(400).json({
        error: error.message || "Transaction processing failed"
      });
    }
  }
);

// CHANGE USER BLOCK STATUS
app.post(
  "/api/admin/users/status",
  verifyUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const { userId, blocked } = req.body;

      if (!userId || typeof blocked !== "boolean") {
        return res.status(400).json({
          error: "Invalid user status"
        });
      }

      await db.collection("users").doc(userId).update({
        blocked
      });

      res.json({
        success: true
      });

    } catch (error) {
      res.status(500).json({
        error: "Could not update user status"
      });
    }
  }
);

// CHANGE USER ROLE
app.post(
  "/api/admin/users/role",
  verifyUser,
  verifyAdmin,
  async (req, res) => {
    try {
      const { userId, role } = req.body;

      if (!userId || !["user", "admin"].includes(role)) {
        return res.status(400).json({
          error: "Invalid user role"
        });
      }

      if (userId === req.user.uid) {
        return res.status(400).json({
          error: "You cannot change your own role"
        });
      }

      await db.collection("users").doc(userId).update({
        role
      });

      res.json({
        success: true
      });

    } catch (error) {
      res.status(500).json({
        error: "Could not update user role"
      });
    }
  }
);

// UNKNOWN ROUTE
app.use((req, res) => {
  res.status(404).json({
    error: "API route not found"
  });
});

// ERROR HANDLER
app.use((error, req, res, next) => {
  if (error.message === "Origin not allowed") {
    return res.status(403).json({
      error: "Origin not allowed"
    });
  }

  res.status(500).json({
    error: "Server error"
  });
});

// START SERVER
const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BAZABYOSE API running on port ${PORT}`);
});
