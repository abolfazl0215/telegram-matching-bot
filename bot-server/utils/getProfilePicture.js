async function getUserProfilePicture(ctx) {
    const telegramId = ctx.from.id;
  
    try {
      // دریافت تصاویر پروفایل کاربر
      const profilePhotos = await ctx.telegram.getUserProfilePhotos(
        telegramId,
        {
          offset: 0,
          limit: 1, // فقط آخرین عکس پروفایل
        },
      );
  
      if (profilePhotos.total_count > 0) {
        // دریافت file_id بزرگترین سایز عکس
        const photo = profilePhotos.photos[0];
        const largestPhoto = photo[photo.length - 1]; // آخرین المان بزرگترین سایز است
  
        // دریافت لینک فایل
        const fileInfo = await ctx.telegram.getFile(
          largestPhoto.file_id,
        );
        const fileUrl = `https://api.telegram.org/file/bot${ctx.telegram.token}/${fileInfo.file_path}`;
  
        return {
          fileId: largestPhoto.file_id,
          fileUrl: fileUrl,
          width: largestPhoto.width,
          height: largestPhoto.height,
        };
      } else {
        return null; // کاربر عکس پروفایل ندارد
      }
    } catch (error) {
      console.error("خطا در دریافت عکس پروفایل:", error);
      return null;
    }
  }

  module.exports = {
    getUserProfilePicture,
  };
  