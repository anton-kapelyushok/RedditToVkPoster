'use strict'
const snoowrap = require('snoowrap');
const pmongo = require('promised-mongo');
const assert = require('assert');
const rp = require('request-promise');
const fs = require('fs');
const https = require('https');
const mkdirp = require('mkdirp');

const config = require('./config');
const vkAccessToken = config.vkAccessToken;
const redditConfig = config.redditConfig;
const tmpFolder = config.tmpFolder;
const subreddit = config.subreddit;
const vkGroupId = config.vkGroupId;
mkdirp(tmpFolder);

const mongoConnectionString = 'mongodb://localhost:27017/reddit-to-vk-poster';
const gfycatEndpoint = 'https://gfycat.com/cajax/get/';

const vkUploadVideoEndpoint = 'https://api.vk.com/method/video.save';
const vkVersion = '5.53';


const db = pmongo(mongoConnectionString);
const r = new snoowrap(redditConfig);

let promises = [];
// db.documents.find().toArray().then(console.log).then(() => db.close());

const postAlreadyProcessed = id => db.processedVideos.findOne({videoId: id})
    .then(doc => {return !!doc;});

const rememberPost = id =>  db.processedVideos.save({videoId: id});

const download = function(url, dest, cb) {
  var file = fs.createWriteStream(dest);
  var request = https.get(url, function(response) {
    response.pipe(file);
    file.on('finish', function() {
      file.close(cb);  // close() is async, call cb after close completes.
    });
  }).on('error', function(err) { // Handle errors
    fs.unlink(dest); // Delete the file async. (But we don't check the result)
    if (cb) cb(err.message);
  });
};

const deleteFile = file => new Promise((resolve, reject) =>
      fs.unlink(file, () => resolve())
);

const promiseDownload = (url, dest) => new Promise((resolve, reject) => {

  download(url, dest, msg => resolve(dest));
});


const postVideoToVk = file => {
  return uri => {
    const options = {
      method: 'POST',
      uri: uri,
      formData: {
        video_file: fs.createReadStream(file)
      }
    }
    return rp(options);
  };
}

const uploadVideoToVk = fileAndPost => {
  let vkPost = fileAndPost.vkPost;
  let file = fileAndPost.file;
  return rp({
    uri: vkUploadVideoEndpoint,
    qs: {
      access_token: vkAccessToken,
      wallpost: 1,
      name: vkPost.title,
      group_id: vkGroupId,
      v: vkVersion
    },
    json: true
  })
  .then(response => response.response.upload_url)
    .then(postVideoToVk(file))
};

const extractUrls = listing =>
  listing
      .map(item => ({
          url: item.url,
          title: item.title,
          id: item.id,
          author: item.author
      }))
      .filter(item => item.url);


const processGfycat = item => {
  const splittedUrl = item.url.split('/');
  const videoId = splittedUrl[splittedUrl.length-1];
  return rp({
    uri: gfycatEndpoint + videoId,
    json: true
  }).then(response => {
      return {
        type: 'video',
        videoUrl: response.gfyItem.mobileUrl
      }
  });
};

const downloadVideo = (url, saveTo) => {
  return promiseDownload(url, saveTo);
};

const appendInfo = (vkPost, redditPost) => {
    return Object.assign({}, vkPost, {
        id: redditPost.id,
        author: redditPost.author.name,
        title: redditPost.title,
        link: redditPost.permalink
      });
};

const getConvertToVkPostPromise = redditPost => {
  let processPromise = null;
  if (redditPost.url && redditPost.url.indexOf('https://gfycat.com') != -1)  {
    processPromise = processGfycat;
  }
  return processPromise;
};


const processVideo = vkPost => {

  let fileAndPost = {
    vkPost: vkPost,
    file: tmpFolder + '/' + vkPost.id + '.mp4'
  };

  return downloadVideo(vkPost.videoUrl, fileAndPost.file)
      .then(() => uploadVideoToVk(fileAndPost))
      .then(() => deleteFile(fileAndPost.file));
};

const processVkPost = vkPost => {
  switch (vkPost.type) {
    case 'video':
      return processVideo(vkPost).catch(console.error);
    default:
      break;
  }
}

const processRedditPosts = listing => {
  return listing.map(redditPost => {
    let convertToVkPostPromise = getConvertToVkPostPromise(redditPost);
    return {redditPost: redditPost, convertToVkPostPromise: convertToVkPostPromise};
  }).filter(item => item.convertToVkPostPromise)
    .map(item => {
      return postAlreadyProcessed(item.redditPost.id)
        .then(processed => {
          console.log(processed + ' '  + item.redditPost.id);
          if (processed) { return; }
          return rememberPost(item.redditPost.id)
            .then(() => item.convertToVkPostPromise(item.redditPost))
            .then(vkPost => appendInfo(vkPost, item.redditPost))
            .then(processVkPost)
            .catch(console.error);
        })
    })
};


r.getSubreddit(subreddit)
  .getTop({time: 'day'})
  .then(processRedditPosts)
  .then(promises => Promise.all(promises).then(() => db.close()));
