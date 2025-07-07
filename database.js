import { MongoClient } from "mongodb";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();
const { MONGODB_URL, DATABASE_NAME } = process.env;

let client;
let database;

export async function connectToMongoDB() {
  try {
    // Bağlantı seçenekleri
    const options = {
      useNewUrlParser: true,
      useUnifiedTopology: true
    };

    // Eğer local değilse, TLS/SSL için CA dosyasını ekle
    if (!/localhost|127\.0\.0\.1/.test(MONGODB_URL)) {
      // Atlas için genelde sistem CA'ları yeterli; 
      // özel bir CA gerekiyorsa aşağıdaki satırı açıp dosya yolunu ver:
      // options.tlsCAFile = path.resolve(__dirname, "ca.pem");
    }

    client = new MongoClient(MONGODB_URL, options);
    await client.connect();

    database = client.db(DATABASE_NAME);

    // Bağlantı testi (ping)
    await database.command({ ping: 1 });
    console.log(`MongoDB bağlantısı başarılı: ${DATABASE_NAME}`);

    return database;
  } catch (e) {
    console.error("MongoDB bağlantı hatası:", e);
    return null;
  }
}

async function saveCallRecord(candidateId, callRecord) {
  try {
    const database = await initDB();
    const collection = database.collection("call_records");
    
    const record = {
      candidateId: candidateId,
      callRecord: callRecord,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    const result = await collection.insertOne(record);
    console.log(`✅ Call record saved for candidate ${candidateId}:`, result.insertedId);
    return result;
  } catch (error) {
    console.error("❌ Error saving call record:", error);
    throw error;
  }
}