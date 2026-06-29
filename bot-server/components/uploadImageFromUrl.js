const axios = require("axios");
const FormData = require("form-data");
const path = require("path");
const stream = require("stream"); // ماژول stream را اضافه کنید

async function uploadImageFromUrl(fileLink) {
  let responseStream; // برای نگهداری stream دانلود

  try {
    // 1. دانلود تصویر از تلگرام به صورت Stream
    const telegramResponse = await axios.get(fileLink, {
      responseType: "stream", // <-- تغییر مهم: دریافت به صورت stream
      timeout: 20000,
      headers: {
        Authorization: `Bearer 890588018:8B58TpZfCWe5lZw3KPPgWChNgRxrUW0DIbg`,
        Accept: "application/octet-stream,*/*",
      },
      // validateStatus: () => true, // این برای streamها معمولاً لازم نیست
    });

    responseStream = telegramResponse.data; // Stream دانلود شده

    // console.log("Downloaded stream successfully");

    const form = new FormData();
    const fileName = `image-${Date.now()}.jpg`;

    // 2. اضافه کردن Stream فایل به FormData بدون بارگذاری در حافظه
    form.append("image", responseStream, {
      // responseStream را مستقیماً به form.append اضافه می‌کنیم
      filename: fileName,
      contentType: "image/jpeg", // صراحتاً می‌گوییم فایل تصویر است
    });

    // 3. ارسال به سرور آپلود
    // برای ارسال stream، نیاز به یک pipeline یا استفاده از axios با configuration مناسب داریم
    // Axios خودش می‌تواند stream را پردازش کند اگر در body قرار گیرد.
    const uploadResponse = await axios.post(
      "https://pounes.ir/upload-image",
      form, // FormData که شامل stream است
      {
        headers: {
          ...form.getHeaders(), // headers مربوط به FormData
        },
        timeout: 50000,
        // maxBodyLength و maxContentLength لازم نیستند چون stream اندازه مشخصی ندارد
        // ولی اگر سرور شما محدودیت دارد، می‌توانید اضافه کنید
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        onUploadProgress: (progressEvent) => {
          // می‌توانید اینجا پیشرفت آپلود را نمایش دهید (اختیاری)
          // console.log(`Upload progress: ${Math.round((progressEvent.loaded * 100) / progressEvent.total)}%`);
        },
      },
    );

    // console.log("Upload response received:", uploadResponse.data);

    // 4. اطمینان از اتمام خواندن stream (مهم برای جلوگیری از hang شدن)
    // برخی مواقع لازم است stream را pipe کنیم تا مطمئن شویم کامل خوانده شده
    // اما axios معمولاً این کار را خودش انجام می‌دهد.
    // اگر باز هم مشکل بود، می‌توانید از stream.pipeline استفاده کنید.

    return uploadResponse.data.url;
  } catch (error) {
    console.error(
      "خطا در uploadImageFromUrl:",
      error.response?.data || error.message,
    );
    // مهم: اگر هنگام دانلود steam با خطا مواجه شدیم، باید stream را ببندیم
    if (responseStream && responseStream.destroy) {
      responseStream.destroy();
    }
    // throw error; // خطا را دوباره پرتاب کن تا در سطح بالاتر مدیریت شود
  }
}

module.exports = {
  uploadImageFromUrl,
};

// ////////////////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////
// ////////////////////////////////////////////////////////////

// const fs = require("fs");
// const path = require("path");
// const axios = require("axios");
// const sharp = require("sharp");
// const { v4: uuidv4 } = require("uuid");

// const uploadImageFromUrl = async (imageUrl, options = {}) => {
//   // ۱. تعیین نام فایل و مسیر ذخیره‌سازی
//   const fileName = `${Date.now()}-${uuidv4()}.jpg`;
//   const uploadDir = path.join(__dirname, "..", "public", "uploads"); // مسیر پوشه آپلود
//   const filePath = path.join(uploadDir, fileName);

//   // ایجاد پوشه اگر وجود نداشته باشد
//   if (!fs.existsSync(uploadDir)) {
//     fs.mkdirSync(uploadDir, { recursive: true });
//   }

//   // تنظیمات پیش‌فرض برای فشردگی
//   const defaultOptions = {
//     quality: 80,
//     width: 800,
//     height: 800,
//     format: "jpeg",
//   };

//   const config = { ...defaultOptions, ...options };

//   try {
//     // console.log({ imageUrl });
//     // ۲. دانلود تصویر به صورت باینری
//     const response = await axios.get(imageUrl, {
//       responseType: "arraybuffer",
//       timeout: 20000,
//       headers: {
//         // اگر از نوع Bearer پشتیبانی می‌کند:
//         Authorization: `Bearer 890588018:8B58TpZfCWe5lZw3KPPgWChNgRxrUW0DIbg`,
//         Accept: "application/octet-stream,*/*",
//       },
//       validateStatus: () => true, // برای دیباگ: حتی اگر 404/500 شد، جواب را چاپ کنیم
//     });

//     // console.log("status:", response.status);
//     // console.log("headers:", response.headers);
//     // console.log(
//     //   "body head:",
//     //   Buffer.from(response.data).slice(0, 200).toString("utf8"),
//     // );

//     // ۳. پردازش و فشردگی با Sharp

//     console.time("compress");
//     const compressedImageBuffer = await sharp(
//       Buffer.from(response.data),
//     )
//       .resize({
//         width: config.width,
//         height: config.height,
//         fit: "inside",
//         withoutEnlargement: true,
//       })
//       .jpeg({
//         quality: config.quality,
//         progressive: true,
//         mozjpeg: true,
//       })
//       .toBuffer();
//     console.timeEnd("compress");

//     // ۴. ذخیره فایل در سیستم با استفاده از fs
//     fs.writeFileSync(filePath, compressedImageBuffer);
//     // console.log(`File saved to: ${filePath}`);

//     // ۵. بازگرداندن لینک مستقیم (فرض بر این است که سرور شما روی پورت مثلاً ۳۰۰۰ است)
//     // اگر از اکسپرس استفاده می‌کنید، باید پوشه public را استاتیک کنید
//     // مثال: app.use(express.static('public'));
//     const publicUrl = `./public/uploads/${fileName}`;

//     // اگر می‌خواهید آدرس کامل با دامنه برگردانده شود:
//     // const fullUrl = `https://yourdomain.com/${publicUrl}`;

//     return publicUrl;
//   } catch (error) {
//     console.error("خطا در پردازش و ذخیره تصویر:", error.message);
//     throw error;
//   }
// };

// module.exports = {
//   uploadImageFromUrl,
// };

// ///////////////////////////////////////////////////////
// ///////////////////////////////////////////////////////
// ///////////////////////////////////////////////////////
// ///////////////////////////////////////////////////////

// const {
//   S3Client,
//   PutObjectCommand,
//   GetObjectCommand,
//   ListObjectsV2Command,
// } = require("@aws-sdk/client-s3");

// const { default: axios } = require("axios");
// const sharp = require("sharp");
// const { v4: uuidv4 } = require("uuid");

// const uploadImageFromUrl = async (imageUrl, options = {}) => {
//   const fileName = `${Date.now()}-${uuidv4()}.jpg`;
//   console.log({ fileName });

//   // تنظیمات پیش‌فرض برای فشردگی
//   const defaultOptions = {
//     quality: 80, // کیفیت JPEG (1-100)
//     width: 800, // حداکثر عرض
//     height: 800, // حداکثر ارتفاع
//     format: "jpeg", // فرمت خروجی
//   };

//   const ENDPOINT = "https://minio-sug43t.chbk.dev";
//   const ACCESS_KEY = "B6AJN7fqbMd0h5RCAtEY1dMCwioXxt0O";
//   const SECRET_KEY = "c8YsXiPVhMRY0ldgSwWX2N6etXhIgzbC";
//   const BUCKET_NAME = "pounes";

//   const config = { ...defaultOptions, ...options };

//   // const client = new S3Client({
//   //   region: "default",
//   //   endpoint: ENDPOINT,
//   //   credentials: {
//   //     accessKeyId: ACCESS_KEY,
//   //     secretAccessKey: SECRET_KEY,
//   //   },
//   // });

//   const client = new S3Client({
//     region: "default", // یا اگر سرویس‌دهنده خاصی است 'us-east-1'
//     endpoint: ENDPOINT,
//     forcePathStyle: true, // این خط کلید اصلی مشکل شماست
//     credentials: {
//       accessKeyId: ACCESS_KEY,
//       secretAccessKey: SECRET_KEY,
//     },
//   });

//   try {
//     // دانلود تصویر به صورت باینری
//     // console.time("downloadImage");
//     const response = await axios.get(imageUrl, {
//       responseType: "arraybuffer",
//     });
//     // console.timeEnd("downloadImage");

//     console.log({ res: response.data });

//     // فشردگی و بهینه‌سازی تصویر با Sharp
//     console.time("compress");
//     const compressedImageBuffer = await sharp(
//       Buffer.from(response.data),
//     )
//       .resize({
//         width: config.width,
//         height: config.height,
//         fit: "inside", // حفظ نسبت ابعاد
//         withoutEnlargement: true, // عدم بزرگ‌نمایی تصاویر کوچک
//       })
//       .jpeg({
//         quality: config.quality,
//         progressive: true, // بارگذاری تدریجی
//         mozjpeg: true, // استفاده از موتور mozjpeg برای فشردگی بهتر
//       })
//       .toBuffer();
//     console.timeEnd("compress");

//     const params = {
//       Body: compressedImageBuffer,
//       Bucket: BUCKET_NAME,
//       Key: fileName,
//       ACL: "public-read",
//     };

//     try {
//       await client.send(new PutObjectCommand(params));
//     } catch (error) {
//       console.log(error);
//     }

//     return `${fileName}`;
//   } catch (error) {
//     console.error("خطا در آپلود تصویر از URL:", error);
//     throw error;
//   }
// };

// module.exports = {
//   uploadImageFromUrl,
// };
