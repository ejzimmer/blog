---
layout: base-layout.njk
title: Hooks Tests Acting Up
date: 2021-03-31
tags: ['post', 'react']
---

A co-worker and I were writing tests for a hook we'd created the other day, and we kept running into this mysterious warning.

```
    Warning: An update to TestHook inside a test was not wrapped in act(...).
    
    When testing, code that causes React state updates should be wrapped into act(...):
    
    act(() => {
      /* fire events that update state */
    });
    /* assert on the output */
    
    This ensures that you're testing the behavior the user would see in the browser. Learn more at https://fb.me/react-wrap-tests-with-act
        in TestHook
        in Suspense
```

We didn't find this warning particularly enlightening, especially given that a cursory reading of the linked documentation reveals
```
You might find using act() directly a bit too verbose. To avoid some of the boilerplate, you could use a library like React Testing Library, whose helpers are wrapped with act().
```

We were using React Testing Library! Everything was already wrapped in `act()`! And our tests were actually passing. It was a bit of a mystery, so we decided to dig a little deeper and work out what was really going on. What resulted was a wild ride through the inner workings of hooks, testing utilities, and how asynchronous events are handled in JavaScript. If you're curious too, then keep reading. If you just want to know how to make the warning go away, then skip ahead to the tl;dr.

__Hooks__
This warning is very specifically related to hooks, so to understand what's going on, we first need to understand how hooks work.

Hooks give us a way to store state in a functional component. In the case of `useState()`, that state is the actual component state. But other hooks store other kinds of state - `useRef()` stores a reference to a particular object, while `useEffect()` and `useCallback()` store functions. We can't store these things inside the component - they'd get re-created as new objects each time the component re-rendered. But we also don't want to store them in global state, where anyone could just come along and change them.

Fortunately, JavaScript has a nice way to create private state specific to a particular function. We can use closures!

```js
function counter() {
    let _count = 0;
    return {
        increment: () => ++_count,
        current: () => _count
   }
}

const myCounter = counter()
console.log(myCounter.current()) // 0
myCounter.increment()
console.log(myCounter.current()) // 1
console.log(_count) // undefined
```
Here, the `counter()` function stores its internal state in a variable called `_count`. It also returns an object with two functions on it - `increment()` and `count()`. Because `_count` is defined outside of `increment()` and `current()`, both functions share the same value, and that value is maintained independent of calls to either function. And, because `_count` is defined inside `counter()`, nothing outside `counter()` can access it. This is  we want in a hook!

(If this seems confusing, have a look at [the MDN guide to closures](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Closures), or [the chapter on scope and closures in Kyle Simpson's excellent You Don't Know JS Yet](https://github.com/getify/You-Dont-Know-JS/blob/2nd-ed/scope-closures/README.md))

If we were to have a go at defining the `useState()` hook, it might look something like this
```js
function React() {
  let _state
  return {
    useState: (initial) => {
      _state = _state || initial // if _state hasn't been set to anything, set it to the initial value
      setState = (newState) => _state = newState

      return [_state, setState]
    }
    // ... everything else React does
  }
}
```


This version of `useState` gives us exactly what we wanted - an external place to store state that isn't accessible to every other bit of code running on the page. It does, however, have a serious downside. It can only store one bit of state. If our component called `useState` multiple times, each new bit of state would overwrite the previous one.

We can solve the only-one-bit-of-state problem by replacing the `_state` variable with an *array* of state values. Once we do this, we also need to add some logic to control which index of the array we should be accessing at any given time.

```js
function React() {
  const _state = []
  let currentIndex = 0
  return {
    useState: (initial) => {
      // access the bit of state at the current index
      _state[currentIndex] = _state[currentIndex] || initial

      // make sure that we always use the same index for this particular bit of state
      // (by creating another closure!)
      const thisIndex = currentIndex
      setState = (newState) => _state[thisIndex] = newState

      // increment currentIndex so that the next hook accesses the next element in the array
      currentIndex++
      
      // return our bit of state, and a function to update it. This setState function will always
      // point to the correct element in the array, because we created a closure using thisIndex
      return [_state[thisIndex], setState]
    }
    render: () => {
       // ... actually render the component
       
       // once the component has rendered, set current index back to 0, so we're
       // ready for the next time the component runs
       currentIndex = 0
    }
    // ... whatever else React does
  }
}
```


Now that our state is in an array, we also need `currentIndex` to keep track of where each bit of state is stored within the array. Each time `useState()` is called, it saves the current value of `currentIndex` to `thisIndex`. The `setState()` function that is returned creates a closure around `thisIndex`. This means that if our `useState()` hook is called three times within a component, we'll get three different pieces of state, each with their own setter function, pointing to the correct index in the array. Finally, after our component has rendered, `currentIndex` is set back to 0, ready for the next call to `render()`.


If you're interested in understanding this better (or you would like examples of how other hooks work), then you should definitely check out [Shawn Wang's post and video on hooks](https://www.swyx.io/getting-closure-on-hooks/), which is what this code was, uh, heavily inspired by.

__Testing Hooks__
One thing that this code hopefully makes clear is that a hook will really only work if it's called from within the context of a component function (as per the [Rules of Hooks](https://reactjs.org/docs/hooks-rules.html)). Hooks within a function need to be called in the correct order, so that `currentIndex` is incremented correctly, and `currentIndex` needs to be reset after each render. This means that we can't test hooks just by calling them like regular JavaScript functions. Instead, we need to use something like `renderHook()`.

```js
it('returns the initial value', () => {
    const { result } = renderHook(() => useCounter())
    expect(result.current.count).toBe(0)
})
```

We pass `renderHook()` a callback function which calls our hook. `renderHook()` generates a test component, which calls the callback function from within it. This results in our hook being called from within a component, without us having to go to all the hassle of creating a component ourselves!

`renderHook()` returns an object with a property called `result`. The `result` object has a property called `current`, which contains the result of calling our callback.

This might seem like a rather convoluted way of going about things, but there's a very good reason for it. `result.current` will always point to the value returned by the hook, even if that value changes after `renderHook()` has returned. This allows us to test hooks which are able to change their own state.

To understand what's going on, lets imagine that `renderHook()` just returned the value returned by `useCounter()`.

```js
it('increments the counter', () => {
    const result = renderHook(() => useCounter())
    const { count, incrementCount } = result
    expect(count).toBe(0) // all good!
    incrementCount()
    expect(count).toBe(1) // oh noes, even though the hook has updated the state of the variable in its closure
                          // _this_ count variable still points to the initial value of 0, and the test fails!
})
```
Our test fails! But why?

Well. Initially, we call `renderHook()`, which calls `useCounter()`. `useCounter()` returns an object with a `count` property with a value of 0, and a setter function, which can be used to increment the value of `count`. This object is returned by `renderHook()` and stored in `result` in our test.

![initial state](https://raw.githubusercontent.com/ejzimmer/blog/master/posts/2020/images/initial_state.png)
Our test then calls `incrementCount()`, which updates the state of the fake test component. Updating the state causes the component to re-render, which calls `useCounter()` again. `useCounter()` returns a new object, with the value of `count` set to 1.

![after increment](https://raw.githubusercontent.com/ejzimmer/blog/master/posts/2020/images/after_increment.png)
There's no way for `useCounter()` to pass this new object back to our test, so `result` continues to point to the original object, and our test fails.

To solve this problem, `renderHook()` can instead return an object with a `current` property. 

![after increment](https://raw.githubusercontent.com/ejzimmer/blog/master/posts/2020/images/actual.png)
Now, when we call `incrementCount()`, the fake test component re-renders, and stores the new result returned by `useCounter()` in the `current` property.

![after increment](https://raw.githubusercontent.com/ejzimmer/blog/master/posts/2020/images/actual_after_increment.png)
So now our test always has access to the most recent value returned by `useCounter()`, and it passes!

```js
it('increments the counter', () => {
    const result = renderHook(() => useCounter())
    expect(result.current.count).toBe(0) // all good, just like before
    result.current.incrementCount() // the value of `current` is updated
    expect(result.current.count).toBe(1) // now this works too!
})
```

Of course, in the Real World, things are slightly more complicated than this - `renderHook()` actually returns an object with a property called `result`, which contains an object with a property called `current`. So our test really looks like this:
```js
it('increments the counter', () => {
    const { result } = renderHook(() => useCounter())
    expect(result.current.count).toBe(0) // all good, just like before
    result.current.incrementCount() // the value of `current` is updated
    expect(result.current.count).toBe(1) // now this works too!
})
```
Fortunately, the reason for this extra bit of indirection is nowhere near as complicated as the first bit. `renderHook()` also needs to return a couple of utility functions, for doing things like forcing the test component to re-render, unmounting the test component (so we can test our clean-up code), and some other utilities that we'll talk about later. Bundling them up in a single object along with the result is just convenient.
```js
const { result, rerender, unmount, ...asynUtils } = renderHook(...)
```

__The Act Warning__
This - finally - brings us to the warning that started this whole journey. 

```
Warning: An update to TestHook inside a test was not wrapped in act(...).
    
    When testing, code that causes React state updates should be wrapped into act(...):
    
    act(() => {
      /* fire events that update state */
    });
    /* assert on the output */
    
    This ensures that you're testing the behavior the user would see in the browser. Learn more at https://fb.me/react-wrap-tests-with-act
        in TestHook
        in Suspense
```

As I mentioned earlier, this is particularly confusing because the docs clearly state that both `render()` and `renderHook()` already wrap the code in `act()`.

So what's going on?

Well, one hint is that we're only going to see this warning if our hook is doing something asynchronous - like calling an API, or using a timer. If our hook uses `async/await`, or does something in the `then()` of a promise, or a `setTimeout()` callback, it's potentially going to cause a problem. This is because of how JavaScript manages these asynchronous events. 

Imagine we had a hook for fetching details about Nintendo amiibo:
```js
function useAmiibo(name) {
   const [amiibo, setAmiibo] = useState()
   fetch(`https://www.amiiboapi.com/api/amiibo/?name=${name}`)
    .then((response) => response.json())
    .then((response) => setAmiibo(response))
    
   return amiibo
}
```
(This is a real API; you can call it if you like. Amiibo are figurines used in various Nintendo games.)

We can test it with a test like this:

```js
it('fetches the Zelda amiibo', () =>  {
    const { result } = renderHook(() => useAmiibo(name))
    expect(result.current.amiibo[0].gameSeries.toBe('The Legend of Zelda')
})
```

The code will run in the following order:
1. `renderHook(() => useAmiibo(name))` in the test
2. `renderHook()` internal code, which calls `useAmiibo()`
3. `const [amiibo, setAmiibo] = useState()` in `useAmiibo()`
4. `fetch(...)` in `useAmiibo()`

At this point, `fetch()` will send off the network request, and `useAmiibo()` will return the `amiibo` object (which currently has a value of `undefined`). The final line of the test will run, and the test will fail, because `result.current` currently points to an `undefined` `amiibo`. 

_After_ the test has returned, the `then()` blocks of the hook will run. `renderHook()` will notice that the state changed after the test finished, and it will throw that pesky warning.

In this case, the warning isn't very helpful, because the test fails. We already know something has gone wrong. The warning is really there to guard against tests _passing_ incorrectly. Imagine if we had a test that checked that an error wasn't thrown.

```js
it('fetches nothing', () => {
    expect(renderHook(() => useAmiibo(name))).not.toThrow()
})
```

This test will pass. But it's not really testing the right thing. If an error was thrown in the `then()` part of our hook, it wouldn't be thrown until *after* the test had already returned successfully. The `act()` warning is warning us about situations like this - cases when an asynchronous action would have caused something to happen _after_ the test had already finished. Hopefully you agree that while the wording of the warning is a little confusing, the warning itself is potentially very helpful. After all, reasoning about asynchronous stuff is _hard_.

If you're interested in the details of how JavaScript handles asynchronous code and promises, check out Jake Archibald's article on [https://jakearchibald.com/2015/tasks-microtasks-queues-and-schedules/](Tasks, microtasks, queues and schedules). Or you can watch a [https://www.youtube.com/watch?v=2qDNgBgKsXI](video of me, talking about the Event Loop).


__Can we fix it?__
Yes, we can, and the fix is actually pretty straightforward. One of the utility functions returned by `renderHook()` is a function called `waitForNextUpdate()` which returns a Promise that resolves the next time our hook is called.

```js
it('fetches Zelda', async () => {
    const { result, waitForNextUpdate } = renderHook(() => useAmiibo(name))
    await waitForNextUpdate()
    expect(result.current.amiibo[0].gameSeries.toBe('The Legend of Zelda')
}
```
Now, the test will pause after the hook is rendered. It will wait until the asynchronous `fetch` code returns and the state inside the hook is updated. Then, the test component will re-render, calling our hook again. Finally, the test will resume, using the updated value of `amiibo`, and this time, it will pass!

__One last problem__
While we've now solved the issue of testing our hook, we are left with one last little problem - testing a component that uses our hook. 


```js
function ShowAmiibo({ name }) {
   const amiibo = useAmiibo(name)
   return amiibo && <img src={amiibo.image} alt={name} /> || null
}
```
This component gets a name passed in on `props`, fetches the matching Amiibo and displays it. We can test it like this:
```js
it('shows Zelda', () => {
    render(<ShowAmiibo name='zelda' />)
    expect(screen.getByAltText('zelda')).toBeTruthy()
}
```
But, the test fails and it throws that same warning again! Just like before, the test is completing before the async part of our hook has run. But this time, we can't use `waitForNextUpdate()`, because we never called `renderHook()`.

Luckily, there is a similar function called `waitFor()` provided with React Testing Library. This function can be used to pause our test until a specific condition is true - usually until a specific element has been rendered.
```js 
it('shows Zelda', async () => {
    render(<ShowAmiibo name='zelda')
    await waitFor(() => screen.getByAltText('zelda'))
    expect(screen.getByAltText('zelda').toBeTruthy()
}
```
So now our test renders our component, and then waits until the DOM contains an element with the alt text `zelda`. If the element never appears, the test will eventually time out and fail. In our case though, the element is there, and the test passes!

While the existence of a specific element is the most common thing to wait for, we do have other options. For example, the situation that kicked off this whole investigation involved a hook which called an API to check if a user had access to a specific endpoint. There were three possible scenarios.
1. The user definitely has access. Do nothing.
2. The user definitely doesn't have access. Hide the form component and show a message.
3. We're not sure if the user has access - either the API call hasn't returned yet, or it returned an error. In these cases, we want to do nothing. For our scenario, it was better to allow a potentially unauthorised user to  use the form than to block or slow down an authorised user. (The unauthorised user would get blocked by the API when they submitted the form anyway, so there was no real harm in letting them try.)

Because scenarios 1 and 3 didn't involve any changes to the DOM, we couldn't wait for any specific element to appear on the screen. Instead, we waited for the API call to happen.


```js
it('doesn\'t change anything when the API returns', async () => {
   const spy = jest.spyOn(axios, 'get')
   render(<AccessControlledForm />)
   await waitFor(() => expect(spy).toHaveBeenCalled())
   expect(form).toBeTruthy()
}
```
Another common scenario is needing to wait for an element to disappear. For example, waiting for a loading spinner to disappear can be a good way to wait until an API call returns, without needing to know exactly what is going to appear on the page. In these cases, we can use `waitForElementToBeRemoved()`

```js
it('shows Zelda', async () => {
    render(<ShowAmiibo name='zelda' />
    await waitForElementToBeRemoved(() => screen.getByTestId('spinner'))
    expect(screen.getByAltText('zelda').toBeTruthy()
})
```

And, finally, sometimes the solution is to just do what the warning says, and wrap the call in `act()`.
```js
const submitForm = async () => {  
  await act(async () => {
    const form = screen.getByRole('form')
    fireEvent.submit(form)
  });  
};
```
This is a utility function we use in some tests. It submits a form which triggers an API call. We could wait for the API call to return, and then wait for some change in the DOM, but often we don't really care about the returned result. For example, if we were testing that the form reset itself after submission - there are no DOM changes, only changes to the values of the form elements. In this case, we found using `act()` to be the simplest and clearest way to ensure all our async code executed correctly.

One small word of warning though - if the warning is turning up as a result of a call to `render()` or `renderHook()`, then wrapping it in `act()` isn't going to help, as the call is already wrapped in `act()`. This happens to me a lot when I have a component which makes an API call as soon as it loads. If I call `render()` inside of `beforeEach()`, `beforeEach()` returns before the API call has returned, triggering the warning. This is especially frustrating because the tests all work fine when I call `render()` inside each test - the warning only appears after I refactor my code to use `beforeEach()`! In these cases, I usually use `waitForElementToBeRemoved()` inside `beforeEach()`, to wait for a spinner to disappear.

Finally, if you're wondering why the function is named "act",  and you've made it this far, well, I'd hate for you to leave disappointed. "Act" comes from the "prepare, act, assert" testing pattern - it's equivalent to the "when" in "given, when then", if you're more familiar with that nomenclature. 

__tl;dr__
So, what did we learn?
- Hooks are made of closures and rely on the component lifecycle to work correctly. As a result, we need to use something like `renderHook()` to test them.
- Async code executing after a test has finished will result in a warning being thrown. This is a Good Thing as it helps ensure that we're testing exactly what we intend to test.
- `await waitForNextUpdate()` will pause a test until the test component is re-rendered, giving any async callbacks a chance to run.
- `await waitFor(...)` will wait until a specific condition has been met. We can wait for anything, but the most common use cases are waiting for a DOM element to appear, or waiting for a specific function (like `Axios.get`) to have been called. We can also `await waitForElementToBeRemoved(...)`
- sometimes, it really is best to just do what the warning says and wrap the code in `act()`. This is most useful in cases where our actions have side effects that we don't care about.

Hopefully, all of this has given you a better understanding of how hooks work, and will help you avoid pesky warnings in your tests in the future!






































<!--stackedit_data:
eyJoaXN0b3J5IjpbOTU2NzY2OTk0LDMxNjIwNTg5MSw0NTUwND
YwLDE5NjY0NzI5MDgsOTE3OTM0MjkyLDY0MTI2MTQ1OCwtOTM1
MjI2NTIsLTE0MDA0NzI5NjEsMTE3MDc1ODc5MSw4MTIxNTk5OT
csNTQ0MTQxMjY0LDE1NTc5NDY3MzcsMTc3OTk0ODA5OV19
-->