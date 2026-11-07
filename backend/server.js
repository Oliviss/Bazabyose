
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const cloudinary = require("cloudinary").v2;
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "10mb" }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(origin => origin.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed"));
  }
}));

let firebaseReady = false;
let db;

try {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE64_MISSING");
  }

  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")
  );

  const projectId = process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id;

  if (serviceAccount.project_id !== projectId) {
    throw new Error("FIREBASE_PROJECT_ID_MISMATCH");
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId
    });
  }

  db = admin.firestore();
  firebaseReady = true;
  console.log("Firebase Admin initialized:", projectId);

} catch (error) {
  console.error("FIREBASE INITIALIZATION ERROR:", error.message);
  throw error;
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp();
const cleanString = value => typeof value === "string" ? value.trim() : "";
const serializeDocs = snapshot => snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

async function verifyUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, error: "Login required" });
    }

    req.user = await admin.auth().verifyIdToken(header.substring(7));
    return next();

  } catch (error) {
    console.error("AUTH ERROR:", error.message);
    return res.status(401).json({ success: false, error: "Invalid or expired login token" });
  }
}

async function verifyAdmin(req, res, next) {
  try {
    const userRef = db.collection("users").doc(req.user.uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(403).json({ success: false, error: "Admin account document not found" });
    }

    const userData = userDoc.data();

    if (userData.role !== "admin" || userData.blocked === true || userData.status === "blocked") {
      return res.status(403).json({ success: false, error: "Admin permission required" });
    }

    req.adminRef = userRef;
    req.adminData = userData;
    return next();

  } catch (error) {
    console.error("ADMIN VERIFICATION ERROR:", error);
    return res.status(500).json({ success: false, error: "Could not verify admin permission" });
  }
}

function writeAudit(userId, action, details, status = "success", extra = {}) {
  return db.collection("auditLogs").add({
    userId, action, details, status, ...extra,
    createdAt: serverTimestamp()
  });
}

app.get("/", (req, res) => {
  res.json({
    service: "BAZABYOSE API",
    status: "running",
    firebase: firebaseReady ? "initialized" : "not initialized"
  });
});

app.get("/health", async (req, res) => {
  try {
    if (!firebaseReady || !db) throw new Error("FIREBASE_NOT_INITIALIZED");

    const snapshot = await db.collection("users").limit(1).get();

    return res.json({
      status: "ok",
      service: "bazabyose-api",
      firebase: "connected",
      database: "(default)",
      project: process.env.FIREBASE_PROJECT_ID,
      usersTestCount: snapshot.size
    });

  } catch (error) {
    console.error("FIRESTORE CONNECTION ERROR", error.code, error.message);

    return res.status(503).json({
      status: "error",
      service: "bazabyose-api",
      firebase: "disconnected",
      errorCode: error.code || "UNKNOWN"
    });
  }
});

// ADMIN IDENTITY
app.get("/api/admin/me", verifyUser, verifyAdmin, async (req, res) => {
  res.json({
    success: true,
    isAdmin: true,
    uid: req.user.uid,
    name: req.adminData.fullName || req.adminData.name || "",
    email: req.adminData.email || req.user.email || "",
    role: req.adminData.role,
    accountType: req.adminData.accountType || "personal"
  });
});

// ADMIN DASHBOARD
app.get("/api/admin/dashboard", verifyUser, verifyAdmin, async (req, res) => {
  try {
    const [users, posts, transactions] = await Promise.all([
      db.collection("users").get(),
      db.collection("posts").get(),
      db.collection("transactions").get()
    ]);

    const txList = transactions.docs.map(d => d.data());

    res.json({
      success: true,
      statistics: {
        totalUsers: users.size,
        totalPosts: posts.size,
        totalTransactions: transactions.size,
        pendingTransactions: txList.filter(t => t.status === "pending").length,
        approvedTransactions: txList.filter(t => t.status === "approved").length,
        rejectedTransactions: txList.filter(t => t.status === "rejected").length
      }
    });

  } catch (error) {
    console.error("DASHBOARD ERROR:", error);
    res.status(500).json({ success: false, error: "Could not load dashboard" });
  }
});

// ADMIN LISTS
app.get("/api/admin/users", verifyUser, verifyAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection("users").limit(200).get();
    res.json({ success: true, users: serializeDocs(snapshot) });
  } catch (error) {
    console.error("USERS ERROR:", error);
    res.status(500).json({ success: false, error: "Could not load users" });
  }
});

app.get("/api/admin/posts", verifyUser, verifyAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection("posts").limit(200).get();
    res.json({ success: true, posts: serializeDocs(snapshot) });
  } catch (error) {
    console.error("POSTS ERROR:", error);
    res.status(500).json({ success: false, error: "Could not load posts" });
  }
});

app.get("/api/admin/transactions", verifyUser, verifyAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection("transactions").limit(200).get();
    res.json({ success: true, transactions: serializeDocs(snapshot) });
  } catch (error) {
    console.error("TRANSACTIONS ERROR:", error);
    res.status(500).json({ success: false, error: "Could not load transactions" });
  }
});

app.get("/api/admin/audit-logs", verifyUser, verifyAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection("auditLogs").limit(200).get();
    const logs = serializeDocs(snapshot).sort(
      (a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)
    );

    res.json({ success: true, logs });
  } catch (error) {
    console.error("AUDIT LOGS ERROR:", error);
    res.status(500).json({ success: false, error: "Could not load audit logs" });
  }
});

// ADMIN BLOCK / UNBLOCK
app.post("/api/admin/users/status", verifyUser, verifyAdmin, async (req, res) => {
  try {
    const { userId, blocked } = req.body || {};

    if (!cleanString(userId) || typeof blocked !== "boolean") {
      return res.status(400).json({ success: false, error: "Invalid user status" });
    }

    if (userId === req.user.uid && blocked) {
      return res.status(400).json({ success: false, error: "You cannot block your own account" });
    }

    await db.collection("users").doc(userId).update({
      blocked,
      status: blocked ? "blocked" : "active",
      updatedAt: serverTimestamp()
    });

    await writeAudit(req.user.uid, "USER_STATUS_CHANGED", `User ${userId} set to ${blocked ? "blocked" : "active"}`);

    res.json({ success: true });

  } catch (error) {
    console.error("USER STATUS ERROR:", error);
    res.status(500).json({ success: false, error: "Could not update user status" });
  }
});

// ADMIN ROLE
app.post("/api/admin/users/role", verifyUser, verifyAdmin, async (req, res) => {
  try {
    const { userId, role } = req.body || {};
    const allowedRoles = ["worker", "employer", "broker", "user", "admin"];

    if (!cleanString(userId) || !allowedRoles.includes(role)) {
      return res.status(400).json({ success: false, error: "Invalid user role" });
    }

    if (userId === req.user.uid) {
      return res.status(400).json({ success: false, error: "You cannot change your own role" });
    }

    await db.collection("users").doc(userId).update({
      role,
      updatedAt: serverTimestamp()
    });

    await writeAudit(req.user.uid, "USER_ROLE_CHANGED", `User ${userId} role set to ${role}`);

    res.json({ success: true });

  } catch (error) {
    console.error("USER ROLE ERROR:", error);
    res.status(500).json({ success: false, error: "Could not update user role" });
  }
});

// USER DEPOSIT / CASHOUT
app.post("/api/transactions", verifyUser, async (req, res) => {
  try {
    const { type, amount, phone, txRef } = req.body || {};
    const normalizedPhone = cleanString(phone).replace(/[\s-]/g, "");

    if (!["deposit", "cashout"].includes(type)) {
      return res.status(400).json({ success: false, error: "Invalid transaction type" });
    }

    if (!Number.isSafeInteger(amount) || amount < 100 || amount > 100000000) {
      return res.status(400).json({ success: false, error: "Amount must be a whole number of at least 100 RWF" });
    }

    if (!/^\+?\d{9,15}$/.test(normalizedPhone)) {
      return res.status(400).json({ success: false, error: "Invalid phone number" });
    }

    if (type === "deposit" && !cleanString(txRef)) {
      return res.status(400).json({ success: false, error: "Transaction reference is required" });
    }

    const userRef = db.collection("users").doc(req.user.uid);
    const txRefDoc = db.collection("transactions").doc();

    await db.runTransaction(async transaction => {
      const userSnap = await transaction.get(userRef);

      if (!userSnap.exists) throw new Error("USER_PROFILE_NOT_FOUND");

      const user = userSnap.data();

      if (user.blocked === true || user.status === "blocked") {
        throw new Error("ACCOUNT_BLOCKED");
      }

      if (type === "deposit") {
        const duplicateQuery = db.collection("transactions")
          .where("txRef", "==", cleanString(txRef)).limit(1);

        const duplicate = await transaction.get(duplicateQuery);
        if (!duplicate.empty) throw new Error("DUPLICATE_TRANSACTION_REFERENCE");

      } else {
        const balance = Number(user.balance || 0);

        if (!Number.isFinite(balance) || amount > balance) {
          throw new Error("INSUFFICIENT_BALANCE");
        }

        transaction.update(userRef, {
          balance: admin.firestore.FieldValue.increment(-amount),
          updatedAt: serverTimestamp()
        });
      }

      transaction.create(txRefDoc, {
        userId: req.user.uid,
        type,
        amount,
        phone: normalizedPhone,
        ...(type === "deposit" ? { txRef: cleanString(txRef) } : {}),
        status: "pending",
        createdAt: serverTimestamp()
      });

      const auditRef = db.collection("auditLogs").doc();

      transaction.create(auditRef, {
        userId: req.user.uid,
        action: type === "deposit" ? "DEPOSIT_REQUESTED" : "CASHOUT_REQUESTED",
        details: `${type} request ${amount} RWF`,
        status: "pending",
        createdAt: serverTimestamp()
      });
    });

    res.status(201).json({
      success: true,
      transactionId: txRefDoc.id,
      status: "pending"
    });

  } catch (error) {
    const known = {
      USER_PROFILE_NOT_FOUND: [404, "User profile not found"],
      ACCOUNT_BLOCKED: [403, "Account is blocked"],
      DUPLICATE_TRANSACTION_REFERENCE: [409, "This transaction reference has already been submitted"],
      INSUFFICIENT_BALANCE: [400, "Insufficient balance for this cash-out"]
    };

    if (known[error.message]) {
      return res.status(known[error.message][0]).json({
        success: false,
        error: known[error.message][1]
      });
    }

    console.error("CREATE TRANSACTION ERROR:", error);
    res.status(500).json({ success: false, error: "Could not create transaction" });
  }
});

// USER HISTORY
app.get("/api/transactions/mine", verifyUser, async (req, res) => {
  try {
    const snapshot = await db.collection("transactions")
      .where("userId", "==", req.user.uid).limit(200).get();

    const transactions = serializeDocs(snapshot).sort(
      (a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)
    );

    res.json({ success: true, transactions });

  } catch (error) {
    console.error("MY TRANSACTIONS ERROR:", error);
    res.status(500).json({ success: false, error: "Could not load your transactions" });
  }
});

// ADMIN APPROVE / REJECT
app.post("/api/admin/transactions/:transactionId/process", verifyUser, verifyAdmin, async (req, res) => {
  try {
    const transactionId = cleanString(req.params.transactionId);
    const decision = req.body?.decision;

    if (!transactionId || !["approve", "reject"].includes(decision)) {
      return res.status(400).json({ success: false, error: "Invalid transaction decision" });
    }

    const txRef = db.collection("transactions").doc(transactionId);

    await db.runTransaction(async transaction => {
      const txSnap = await transaction.get(txRef);

      if (!txSnap.exists) throw new Error("TRANSACTION_NOT_FOUND");

      const tx = txSnap.data();

      if (tx.status !== "pending") throw new Error("TRANSACTION_ALREADY_PROCESSED");
      if (!["deposit", "cashout"].includes(tx.type)) throw new Error("INVALID_TRANSACTION_TYPE");

      const userRef = db.collection("users").doc(tx.userId);
      const userSnap = await transaction.get(userRef);

      if (!userSnap.exists) throw new Error("TRANSACTION_USER_NOT_FOUND");

      if (tx.type === "deposit" && decision === "approve") {
        transaction.update(userRef, {
          balance: admin.firestore.FieldValue.increment(Number(tx.amount)),
          updatedAt: serverTimestamp()
        });
      }

      if (tx.type === "cashout" && decision === "reject") {
        transaction.update(userRef, {
          balance: admin.firestore.FieldValue.increment(Number(tx.amount)),
          updatedAt: serverTimestamp()
        });
      }

      transaction.update(txRef, {
        status: decision === "approve" ? "approved" : "rejected",
        processedAt: serverTimestamp(),
        processedBy: req.user.uid
      });

      const auditRef = db.collection("auditLogs").doc();

      transaction.create(auditRef, {
        userId: req.user.uid,
        action: `TRANSACTION_${decision.toUpperCase()}`,
        details: `${tx.type} ${transactionId} ${decision}`,
        status: "success",
        createdAt: serverTimestamp()
      });
    });

    res.json({
      success: true,
      transactionId,
      decision,
      status: decision === "approve" ? "approved" : "rejected"
    });

  } catch (error) {
    if (error.message === "TRANSACTION_NOT_FOUND") {
      return res.status(404).json({ success: false, error: "Transaction not found" });
    }

    if (error.message === "TRANSACTION_ALREADY_PROCESSED") {
      return res.status(409).json({ success: false, error: "Transaction has already been processed" });
    }

    if (error.message === "TRANSACTION_USER_NOT_FOUND") {
      return res.status(404).json({ success: false, error: "Transaction user not found" });
    }

    console.error("PROCESS TRANSACTION ERROR:", error);
    res.status(500).json({ success: false, error: "Could not process transaction" });
  }
});

// CLOUDINARY SIGNED UPLOAD
app.post("/api/media/sign", verifyUser, async (req, res) => {
  try {
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      return res.status(503).json({ success: false, error: "Cloudinary is not configured" });
    }

    const timestamp = Math.round(Date.now() / 1000);
    const params = { timestamp, folder: "bazabyose/public" };

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
    console.error("CLOUDINARY ERROR:", error);
    res.status(500).json({ success: false, error: "Could not create upload signature" });
  }
});

// 404
app.use((req, res) => {
  res.status(404).json({ success: false, error: "API route not found" });
});

// ERROR HANDLER
app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error);

  if (error.message === "Origin not allowed") {
    return res.status(403).json({ success: false, error: "Origin not allowed" });
  }

  res.status(500).json({ success: false, error: "Server error" });
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("BAZABYOSE API RUNNING");
  console.log("Port:", PORT);
  console.log("Firebase initialized:", firebaseReady);
  console.log("Firestore database: (default)");
});
