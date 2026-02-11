LanguageTool is **the best** choice, for your grammar/spell checking apps, check it out [here](https://languagetool.org/).

**INSTALLATION:**

```
$ npm install languagetool-api
```

After you install package, make sure to require it in your application!

```js
const languagetool = require("languagetool-api");
```

**USAGE:**

`languagetool.check()` takes 2 arguments:

1. Object with request parameters (for more details see: **check() object params**)
2. Callback function

Here's an example:

```js
const languagetool = require("languagetool-api");

var params = {
  language: "pl-PL", // This is required! You can get list of language codes with languagetool.codes
  text: "Piekasz", // This is required too!
};

languagetool.check(params, function(err, res){
	if(err){
	   console.log(err);
	} else{
	   console.log(res);
	}
});
```

`res` can be used with other functions provided by wrapper. These functions are listed below **check() object params** section.

**check() object params**

As you know, `check()` function needs object with parameters. They're listed and compared below:

|  Name             |   Required?       | Type      |Description                                     |Example                  |
|-------------------|-------------------|-----------|------------------------------------------------|-------------------------|
|language           |yes                | string    |Code of language                                |"pl-PL"                  |
|text               |yes                | string    |Text to check                                   |"Piekarz"                |
|disabledRules      |no                 | array     |Array of rule IDs                               |["MORFOLOGIK_RULE_PL_PL"]|
|enabledRules       |no                 | array     |Array of rule IDs                               |["MORFOLOGIK_RULE_PL_PL"]|
|enabledCategories  |no                 | array     |Array of category IDs                           |["TYPOS"]                |
|disabledCategories |no                 | array     |Array of category IDs                           |["TYPOS"]                |
|preferredVariants  |no                 | array     |Array of language codes                         |["en-GB", "de-AT"]       |
|enabledOnly        |no                 | boolean   |If true, only enabledCategories array is checked|false                    |

**languagetool.showMistakes(res, callback)**

`languagetool.showMistakes` should take `res` from `langaugetool.check` and give you access to array of mistakes (as strings).

Here's an example:
```js
languagetool.check(params, function(err, res){
	if(err){
	   console.log(err);
	} else{
	   languagetool.showMistakes(res, function(arr){
	     arr.forEach(function(item){
	       console.log(item);
	     });
	   });
	};
});
```

**languagetool.bestSuggestion(res, callback)**

This function should also take `res` from `languagetool.check`, and give you access to array of objects with properties: `mistake` (string), and `bestSuggestion` (also string).

Here's an example:

```js
languagetool.check(params, function(err, res){
	if(err){
	   console.log(err);
	} else{
	   languagetool.bestSuggestion(res, function(arr){
	     arr.forEach(function(item){
	       console.log("Best suggestion for " + item.mistake + " is " + item.bestSuggestion);
	     });
	   });
	};
});
```

**NOTE:** 
This wrapper utilizes other packages, that are required for languagetool-api to work properly. Github repository doesn't provide them, but package on npmjs.com does. If you got this package from Github, make sure to install them. Packages are listed in package.json file (see: "dependencies").