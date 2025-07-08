import { initDB } from "./database.js";


/**
 * Telefon numarasını temizler ve uluslararası formata getirir
 */
function cleanPhoneNumber(rawNumber) {
  if (!rawNumber) return null;
  let cleaned = rawNumber.replace(/\s+/g, "");
  // 10 haneli ise başına +90 ekle
  if (cleaned.length === 10) {
    cleaned = `+90${cleaned}`;
  } else if (cleaned.length > 10) {
    if (!cleaned.startsWith("+90")) {
      cleaned = `+90${cleaned.slice(-10)}`;
    }
  }
  return cleaned;
}

/**
 * "Aranacak" durumundaki dökümanlardaki numaraları döner
 */
async function callQueue() {
  const database = await initDB();
  const collection = database.collection("parsed_cv_data");

  const queue = [];
  const cursor = collection.find({ durum: "Aranacak" });

  // 3) Toplam belge sayısı
  const total = await collection.countDocuments();
  const filtered = await collection.countDocuments({ durum: "Aranacak" });
  console.log(`Toplam doküman: ${total}, durum=Aranacak olan: ${filtered}`);

  await cursor.forEach(doc => {
    const raw = doc.parsed_data?.["Kişisel Bilgiler"]?.["Telefon Numarası"];
    const number = cleanPhoneNumber(raw);
    const name = doc.parsed_data?.["Kişisel Bilgiler"]?.["Ad Soyad"] || "Bulunamadı";
    if (number) {
      queue.push({ number, docId: doc._id, name});
    }
  });

  console.log("Queue:", queue);
  return queue;
}

/**
 * Bir dökümanda null/undefined alanları bulur ve path listesini döner
 */
async function extractNullValues(_id) {
  const database = await initDB();
  const collection = database.collection("parsed_cv_data");

  const doc = await collection.findOne({ _id: new ObjectId(_id) });
  if (!doc) {
    return { error: `parsed CV verisi bulunamadı: ${_id}` };
  }

  function findNulls(data, path = "") {
    const results = [];
    if (data && typeof data === "object" && !Array.isArray(data)) {
      for (const [key, value] of Object.entries(data)) {
        const fullPath = path ? `${path}.${key}` : key;
        if (value === null || value === undefined) {
          results.push(fullPath);
        } else {
          results.push(...findNulls(value, fullPath));
        }
      }
    } else if (Array.isArray(data)) {
      data.forEach((item, idx) => {
        const fullPath = `${path}[${idx}]`;
        results.push(...findNulls(item, fullPath));
      });
    }
    return results;
  }

  const parsed = doc.parsed_data || {};
  const nullFields = findNulls(parsed);
  const name = parsed["Kişisel Bilgiler"]?.["Ad Soyad"] || "Bulunamadı";

  
  return (    {
      name,
      nullFields,
      parsedData: parsed
    }
  );
}
 

export { cleanPhoneNumber, callQueue, extractNullValues};
