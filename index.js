'use strict';
const snoowrap = require('snoowrap');
const pmongo = require('promised-mongo');
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
const mongoConnectionString = config.mongoConnectionString;
mkdirp(tmpFolder);


const gfycatEndpoint = 'https://gfycat.com/cajax/get/';

const vkUploadVideoEndpoint = 'https://api.vk.com/method/video.save';
const vkVersion = '5.53';

const db = pmongo(mongoConnectionString);
const r = new snoowrap(redditConfig);

const postAlreadyProcessed = (id, subreddit) => db.processedVideos.findOne({
        videoId: id,
        subreddit: subreddit.toLowerCase()
    })
    .then(doc => {
        return !!doc;
    });

const rememberPost = (id, subreddit) => db.processedVideos.save({
    videoId: id,
    subreddit: subreddit.toLowerCase()
});

const download = function(url, dest, cb) {
    const file = fs.createWriteStream(dest);
    https.get(url, function(response) {
        response.pipe(file);
        file.on('finish', function() {
            file.close(cb); // close() is async, call cb after close completes.
        });
    }).on('error', function(err) { // Handle errors
        fs.unlink(dest); // Delete the file async. (But we don't check the result)
        if (cb) {
            cb(err.message);
        }
    });
};

const deleteFile = file => new Promise((resolve) =>
    fs.unlink(file, resolve)
);

const promiseDownload = (url, dest) => new Promise((resolve) => {
    download(url, dest, () => resolve(dest));
});


const postVideoToVk = file => {
    return uri => {
        const options = {
            method: 'POST',
            uri: uri,
            formData: {
                video_file: fs.createReadStream(file)
            }
        };
        return rp(options);
    };
};

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
        .then(postVideoToVk(file));
};

const processYoutube = item => new Promise(resolve => {
    resolve({
        type: 'videoExternal',
        videoLink: item.url
    });
});

const processGfycat = item => {
    const splittedUrl = item.url.split('/');
    const videoId = splittedUrl[splittedUrl.length - 1];
    return rp({
            uri: gfycatEndpoint + videoId,
            json: true
        })
        .then(response => {
            return {
                type: 'video',
                videoUrl: response.gfyItem.mp4Url
            };
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
    if (redditPost.url && redditPost.url.indexOf('https://gfycat.com') !== -1) {
        processPromise = processGfycat;
    } else if (redditPost.url && redditPost.url.indexOf('https://www.youtube.com') !== -1) {
        processPromise = processYoutube;
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
        .catch(() => console.error('error while downloading or uploading video'))
        .then(() => deleteFile(fileAndPost.file));
};

const processVideoExternal = vkPost => {
    return rp({
            uri: vkUploadVideoEndpoint,
            qs: {
                access_token: vkAccessToken,
                wallpost: 1,
                name: vkPost.title,
                group_id: vkGroupId,
                link: vkPost.videoLink,
                v: vkVersion
            },
            json: true
        })
        .then(response => {
            return rp({
                method: 'GET',
                uri: response.response.upload_url
            });
        });
};

const processVkPost = vkPost => {
    switch (vkPost.type) {
        case 'video':
            return processVideo(vkPost).catch('error while processing video');
        case 'videoExternal':
            return processVideoExternal(vkPost).catch('error while processing external video');
        default:
            break;
    }
};

const processRedditPosts = (listing, subreddit) => {
    return listing.map(redditPost => {
            let convertToVkPostPromise = getConvertToVkPostPromise(redditPost);
            return {
                redditPost: redditPost,
                convertToVkPostPromise: convertToVkPostPromise
            };
        })
        .filter(item => item.convertToVkPostPromise)
        .map(item => {
            return postAlreadyProcessed(item.redditPost.id, subreddit)
                .then(processed => {
                    console.log(processed + ' ' + item.redditPost.id);
                    if (processed) {
                        return;
                    }

                    return item.convertToVkPostPromise(item.redditPost)
                        .then(vkPost => appendInfo(vkPost, item.redditPost))
                        .then(processVkPost)
                        .then(() => rememberPost(item.redditPost.id, subreddit))
                        .then(() => console.log('finished processing ' + item.redditPost.id))
                        .catch(() => console.error('error while processing reddit post'));
                });
        });
};


r.getSubreddit(subreddit)
    .getTop({
        time: 'day'
    })
    .then(listing => processRedditPosts(listing, subreddit))
    .then(promises => Promise.all(promises).then(() => db.close()))
    .catch(() => console.error('error somewhere?'));
